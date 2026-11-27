/** 真实文件系统上的过程存档测试；仅使用独占夹具，不接 DSH 或清理磁盘。 */
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CognitionError } from '@cognition-tree/kernel/types';
import { MAX_PROCESS_BYTES, readProcess, saveProcess, type ProcessRecord } from '../src/server/storage/process';

const local = fileURLToPath(new URL('../../../../.local-work/', import.meta.url));
const absentId = 'a'.repeat(64);

function workspace(): string {
  mkdirSync(local, { recursive: true });
  return mkdtempSync(join(local, 'process-store-'));
}

function archive(root: string): string { return join(root, '.converge', 'process'); }
function file(root: string, id: string): string { return join(archive(root), id, 'record.json'); }

function expectFailure(operation: () => unknown, code: 'missing' | 'invalid' | 'storage'): CognitionError {
  let caught: unknown;
  try { operation(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CognitionError);
  expect(caught).toMatchObject({ code });
  return caught as CognitionError;
}

describe('不可变过程存档', () => {
  it('原样存读，重试不改写，也不建树库或辅助文件', () => {
    const root = workspace();
    const text = '  原始文字\r\n🧠 "引用"\u0000 \n';
    const record = saveProcess(root, 'T1', text);
    expect(record).toEqual({ treeId: 'T1', processId: createHash('sha256').update(JSON.stringify(['T1', text])).digest('hex'), text });
    expect(record.processId).toMatch(/^[0-9a-f]{64}$/);
    expect(readProcess(root, 'T1', record.processId)).toEqual(record);
    const entryFile = file(root, record.processId);
    const before = statSync(entryFile, { bigint: true });
    expect(saveProcess(root, 'T1', text)).toEqual(record);
    expect(statSync(entryFile, { bigint: true })).toMatchObject({ ino: before.ino, mtimeNs: before.mtimeNs, nlink: 1n });
    expect(readdirSync(join(root, '.converge'))).toEqual(['process']);
    expect(readdirSync(archive(root))).toEqual([record.processId]);
    expect(readdirSync(join(archive(root), record.processId))).toEqual(['record.json']);
  });

  it('不打开或改写已有树库', () => {
    const root = workspace();
    const converge = join(root, '.converge');
    mkdirSync(converge);
    const database = join(converge, 'T1.sqlite');
    writeFileSync(database, '不应打开的树库占位');
    const before = statSync(database, { bigint: true });
    const record = saveProcess(root, 'T1', '独立存档');
    expect(readProcess(root, 'T1', record.processId)).toEqual(record);
    expect(readdirSync(converge).sort()).toEqual(['T1.sqlite', 'process']);
    expect(statSync(database, { bigint: true })).toMatchObject({ ino: before.ino, mtimeNs: before.mtimeNs });
    expect(readFileSync(database, 'utf8')).toBe('不应打开的树库占位');
  });

  it('缺失读取不建目录，不读取或删除未发布的暂存', () => {
    const root = workspace();
    expectFailure(() => readProcess(root, 'T1', absentId), 'missing');
    expect(readdirSync(root)).toEqual([]);
    mkdirSync(join(root, '.converge'));
    expectFailure(() => readProcess(root, 'T1', absentId), 'missing');
    expect(readdirSync(join(root, '.converge'))).toEqual([]);

    const publishedElsewhere = saveProcess(workspace(), 'T1', '待发布');
    const staging = join(archive(root), '.pending-fixture');
    mkdirSync(staging, { recursive: true });
    const partial = join(staging, 'record.json');
    writeFileSync(partial, '{');
    expectFailure(() => readProcess(root, 'T1', publishedElsewhere.processId), 'missing');
    expect(readdirSync(archive(root))).toEqual(['.pending-fixture']);
    expect(saveProcess(root, 'T1', '待发布')).toEqual(publishedElsewhere);
    expect(readFileSync(partial, 'utf8')).toBe('{');
  });

  it('按工作区和精确树 ID 隔离，正文差异生成不同 ID', () => {
    const root = workspace();
    const other = workspace();
    const record = saveProcess(root, 'T1', '相同内容');
    expectFailure(() => readProcess(root, 'T2', record.processId), 'missing');
    expectFailure(() => readProcess(root, 't1', record.processId), 'missing');
    expectFailure(() => readProcess(other, 'T1', record.processId), 'missing');
    expect(readdirSync(other)).toEqual([]);
    expect(saveProcess(other, 'T1', record.text)).toEqual(record);
    expect(saveProcess(root, 't1', record.text).processId).not.toBe(record.processId);
    expect(saveProcess(root, 'T1', `${record.text}\n`).processId).not.toBe(record.processId);
  });

  it('拒绝不安全的根、树 ID 和过程 ID，且不留下目录', () => {
    const root = workspace();
    expectFailure(() => saveProcess('relative', 'T1', '正文'), 'invalid');
    expectFailure(() => readProcess('relative', 'T1', absentId), 'invalid');
    for (const id of ['../outside', 'T1/other', 'T1\\other', 'T1:ads', 'T1\n', 'T1\0', 'NUL', 'file:T1', 'T'.repeat(65)]) {
      expectFailure(() => saveProcess(root, id, '正文'), 'invalid');
      expectFailure(() => readProcess(root, id, absentId), 'invalid');
    }
    for (const id of ['../outside', 'A'.repeat(64), `${'a'.repeat(63)}\n`, `${absentId}.json`, '.pending-test']) {
      expectFailure(() => readProcess(root, 'T1', id), 'invalid');
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('按 UTF-8 字节限长并拒绝空白和失配代理项，最大转义记录可读', () => {
    const root = workspace();
    expect(MAX_PROCESS_BYTES).toBe(16_384);
    const unicode = '🧠'.repeat(MAX_PROCESS_BYTES / 4);
    for (const text of ['', ' \t\r\n　', '文字\ud800', '\udfff', `${unicode}x`]) {
      expectFailure(() => saveProcess(root, 'T1', text), 'invalid');
    }
    expect(readdirSync(root)).toEqual([]);
    for (const text of [unicode, '\0'.repeat(MAX_PROCESS_BYTES)]) {
      const record = saveProcess(root, 'T1', text);
      expect(readProcess(root, 'T1', record.processId)).toEqual(record);
    }
  });

  const corruptions: [string, (record: ProcessRecord) => string | Buffer][] = [
    ['正文不符', record => JSON.stringify({ ...record, text: '被改写' })],
    ['树不符', record => JSON.stringify({ ...record, treeId: 'T2' })],
    ['ID 不符', record => JSON.stringify({ ...record, processId: absentId })],
    ['额外字段', record => JSON.stringify({ ...record, extra: true })],
    ['无效 UTF-8', record => {
      const bytes = Buffer.from(JSON.stringify(record));
      const start = bytes.indexOf(Buffer.from('\ufffd'));
      return Buffer.concat([bytes.subarray(0, start), Buffer.from([0xff]), bytes.subarray(start + 3)]);
    }],
    ['记录体积越限', record => JSON.stringify(record) + ' '.repeat(7 * MAX_PROCESS_BYTES)],
  ];

  it.each(corruptions)('拒绝损坏记录，不在重试时覆盖：%s', (_label, damage) => {
    const root = workspace();
    const record = saveProcess(root, 'T1', '原始内容\ufffd');
    const path = file(root, record.processId);
    const corrupt = damage(record);
    writeFileSync(path, corrupt);
    expect(expectFailure(() => readProcess(root, 'T1', record.processId), 'storage').message).not.toContain(root);
    expect(expectFailure(() => saveProcess(root, 'T1', record.text), 'storage').message).not.toContain(root);
    expect(readFileSync(path)).toEqual(Buffer.from(corrupt));
  });

  it('拒绝文件占位的存档目录及预先存在的空目标目录', () => {
    const root = workspace();
    mkdirSync(join(root, '.converge'));
    writeFileSync(archive(root), '占位文件');
    expectFailure(() => readProcess(root, 'T1', absentId), 'storage');
    expectFailure(() => saveProcess(root, 'T1', '待保存'), 'storage');
    expect(readFileSync(archive(root), 'utf8')).toBe('占位文件');

    const other = workspace();
    const record = saveProcess(workspace(), 'T1', '待保存');
    const entry = join(archive(other), record.processId);
    mkdirSync(entry, { recursive: true });
    expectFailure(() => saveProcess(other, 'T1', record.text), 'storage');
    expect(readdirSync(entry)).toEqual([]);
  });

  it('拒绝硬链接记录，不接管目标或改写原文件', () => {
    const root = workspace();
    const external = workspace();
    const record = saveProcess(external, 'T1', '外部记录');
    const source = file(external, record.processId);
    const destination = file(root, record.processId);
    mkdirSync(join(archive(root), record.processId), { recursive: true });
    linkSync(source, destination);
    expectFailure(() => readProcess(root, 'T1', record.processId), 'storage');
    expectFailure(() => saveProcess(root, 'T1', record.text), 'storage');
    expect(statSync(source).nlink).toBe(2);
    expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(record);
  });

  it('拒绝工作区、.converge 和过程目录上的目录链接', ({ skip }) => {
    const external = workspace();
    const root = workspace();
    const first = join(root, 'root-link');
    try { symlinkSync(external, first, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { skip(); return; }
      throw error;
    }
    for (const candidate of [first, root, workspace()]) {
      if (candidate === root) symlinkSync(external, join(candidate, '.converge'), 'junction');
      if (candidate !== root && candidate !== first) {
        mkdirSync(join(candidate, '.converge'));
        symlinkSync(external, archive(candidate), 'junction');
      }
      expectFailure(() => readProcess(candidate, 'T1', absentId), 'storage');
      expectFailure(() => saveProcess(candidate, 'T1', '不可写到外部'), 'storage');
    }
    expect(readdirSync(external)).toEqual([]);
  });
});
