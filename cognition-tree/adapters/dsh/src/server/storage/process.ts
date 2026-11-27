/** 工作区内可按 ID 原样回读的过程存档，与树的 SQLite 文件和事务无关。 */
import { createHash } from 'node:crypto';
import {
  closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { CognitionError } from '@cognition-tree/kernel/types';
import { checkedDirectory, checkedFile, databaseName, sameFile, storageDirectory, workspacePath } from './files';

export type ProcessRecord = { treeId: string; processId: string; text: string };
export const MAX_PROCESS_BYTES = 16_384;

// JSON 控制字符每个 UTF-8 字节最多扩为六字节；其余空间容纳两个 ID 和固定字段。
const MAX_RECORD_BYTES = 6 * MAX_PROCESS_BYTES + 256;
const RECORD_NAME = 'record.json';

function validText(text: unknown): text is string {
  return typeof text === 'string' && text.length <= MAX_PROCESS_BYTES && text.trim().length !== 0
    && Buffer.byteLength(text, 'utf8') <= MAX_PROCESS_BYTES && Buffer.from(text, 'utf8').toString('utf8') === text;
}

function contentId(treeId: string, text: string): string {
  // JSON 二元组区分字段边界，不修剪或规范化正文。
  return createHash('sha256').update(JSON.stringify([treeId, text]), 'utf8').digest('hex');
}

function corrupt(): CognitionError {
  return new CognitionError('storage', '过程存档不是完整且匹配的记录');
}

function storageBoundary<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof CognitionError) throw error;
    // 原始文件系统异常可能带绝对路径，不作为 cause 对外保留。
    throw new CognitionError('storage', '无法访问工作区过程存档');
  }
}

function processDirectory(root: string, create: boolean): string | undefined {
  const converge = storageDirectory(workspacePath(root));
  const directory = join(converge, 'process');
  for (const path of [converge, directory]) {
    if (checkedDirectory(path)) continue;
    if (!create) return undefined;
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!checkedDirectory(path)) throw new CognitionError('storage', '未能创建过程存档目录');
  }
  return directory;
}

function readRecordFile(file: string, expected: BigIntStats): unknown {
  if (expected.size > BigInt(MAX_RECORD_BYTES)) throw corrupt();
  const fd = openSync(file, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(expected, opened) || opened.size !== expected.size) throw corrupt();
    const size = Number(expected.size);
    // 即使检查后文件增长，也只读预期长度外的一个探测字节。
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const current = checkedFile(file);
    if (offset !== size || current === undefined || !sameFile(opened, current) || current.size !== expected.size) {
      throw corrupt();
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
  } finally { closeSync(fd); }
}

function loadRecord(entry: string, id: string): ProcessRecord | undefined {
  if (!checkedDirectory(entry)) return undefined;
  const file = join(entry, RECORD_NAME);
  const info = checkedFile(file);
  if (info === undefined) throw corrupt();
  const value = readRecordFile(file, info);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) {
    throw corrupt();
  }
  const { treeId, processId, text } = value as Record<string, unknown>;
  if (typeof treeId !== 'string' || processId !== id || !validText(text)) throw corrupt();
  try { databaseName(treeId); } catch { throw corrupt(); }
  if (contentId(treeId, text) !== id) throw corrupt();
  return { treeId, processId, text };
}

function sameRecord(existing: ProcessRecord, intended: ProcessRecord): ProcessRecord {
  if (existing.treeId !== intended.treeId || existing.text !== intended.text) throw corrupt();
  return existing;
}

function writeStagingRecord(stage: string, record: ProcessRecord): BigIntStats {
  if (!checkedDirectory(stage)) throw corrupt();
  const file = join(stage, RECORD_NAME);
  const fd = openSync(file, 'wx', 0o600);
  try {
    const opened = fstatSync(fd, { bigint: true });
    const current = checkedFile(file);
    if (current === undefined || !sameFile(opened, current)) throw corrupt();
    writeFileSync(fd, JSON.stringify(record), 'utf8');
    return opened;
  } finally { closeSync(fd); }
}

/** 调用方负责验证树存在；不打开 SQLite。相同树和正文重试时不改写已存记录。 */
export function saveProcess(root: string, treeId: string, text: string): ProcessRecord {
  databaseName(treeId);
  if (!validText(text)) throw new CognitionError('invalid', `过程正文必须为非空白的有效 UTF-8，且不超过 ${MAX_PROCESS_BYTES} 字节`);
  const record = { treeId, processId: contentId(treeId, text), text };
  return storageBoundary(() => {
    const directory = processDirectory(root, true);
    if (directory === undefined) throw corrupt();
    const entry = join(directory, record.processId);
    const existing = loadRecord(entry, record.processId);
    if (existing !== undefined) return sameRecord(existing, record);

    // 发布整个非空目录：同一文件系统内原子可见，且竞争的写入不能覆盖另一完整目录。
    // 失败暂存原样保留；不防本地写入者并发篡改，也不保证断电持久性。
    const stage = mkdtempSync(join(directory, '.pending-'));
    const written = writeStagingRecord(stage, record);
    if (dirname(resolve(stage)) !== directory || dirname(resolve(entry)) !== directory
      || !checkedDirectory(directory) || !checkedDirectory(stage)) throw corrupt();
    const current = checkedFile(join(stage, RECORD_NAME));
    if (current === undefined || !sameFile(written, current)) throw corrupt();
    const raced = loadRecord(entry, record.processId);
    if (raced !== undefined) return sameRecord(raced, record);
    try { renameSync(stage, entry); }
    catch (error) {
      const winner = loadRecord(entry, record.processId);
      if (winner !== undefined) return sameRecord(winner, record);
      throw error;
    }
    return record;
  });
}

/** 仅按明确的 ID 读取，不创建目录、不读暂存内容，也不列举。 */
export function readProcess(root: string, treeId: string, processId: string): ProcessRecord {
  databaseName(treeId);
  if (typeof processId !== 'string' || processId.length !== 64 || /[^0-9a-f]/.test(processId)) {
    throw new CognitionError('invalid', '过程 ID 必须是 64 位小写十六进制');
  }
  return storageBoundary(() => {
    const directory = processDirectory(root, false);
    const record = directory === undefined ? undefined : loadRecord(join(directory, processId), processId);
    if (record === undefined || record.treeId !== treeId) throw new CognitionError('missing', '此树的过程存档不存在');
    return record;
  });
}
