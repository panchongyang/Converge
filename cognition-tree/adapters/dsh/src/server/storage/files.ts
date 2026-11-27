/** 工作区文件边界。只接宿主绑定的绝对根；树 ID 只作安全文件名，不作路径或 SQLite URI。 */
import { randomUUID } from 'node:crypto';
import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CognitionError } from '@cognition-tree/kernel/types';
import { idKey } from './order-keys';
import { APPLICATION_ID, LEGACY_SCHEMA_VERSION, SCHEMA_VERSION } from './schema';

const DATABASE_SUFFIX = '.sqlite';
const SIDECARS = ['-wal', '-shm', '-journal'];
const HEADER = Buffer.from('SQLite format 3\0', 'ascii');

/**
 * 校验并规范宿主注入的工作区根；不创建目录或尝试用其他位置兜底。
 * @param root 宿主解析出的工作区绝对路径
 * @returns 规范化绝对路径；存在性和链接在每次访问时检查
 */
export function workspacePath(root: string): string {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) {
    throw new CognitionError('invalid', '工作区根必须是有效的绝对路径');
  }
  return resolve(root);
}

/**
 * 判断树 ID 能否跨平台直用为文件名，不接受设备名、点、空白、分隔符或流名。
 * @param treeId 内核所选或从单个目录项反解出的树 ID
 */
function isSafeTreeId(treeId: string): boolean {
  return typeof treeId === 'string' && treeId.length > 0 && treeId.length <= 64
    && /^[a-z0-9]/i.test(treeId) && !/[^a-z0-9_-]/i.test(treeId)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(treeId);
}

/**
 * 为可落盘的树 ID 生成一个文件名，拒绝不安全的 ID。
 * @param treeId 内核所选的树 ID，例如 T1
 * @returns 如 T1.sqlite
 */
export function databaseName(treeId: string): string {
  if (!isSafeTreeId(treeId)) throw new CognitionError('invalid', '树 ID 不能作为安全的数据库文件名');
  return `${treeId}${DATABASE_SUFFIX}`;
}

/**
 * 对比绝对路径；Windows 的同一路径可能以不同大小写返回。
 * @param left 已规范化路径
 * @param right 已规范化路径或 realpath 返回值
 * @returns 同一拼写（Windows 忽略大小写）时为 true
 */
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * 识别两次检查之间是否仍是同一个文件，不以路径字符串代替身份检查。
 * @param left 前一次目录项或已打开句柄的状态
 * @param right 后一次状态
 * @returns 设备和文件序号相同且没有额外硬链接时为 true
 */
export function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === 1n && right.nlink === 1n;
}

/**
 * 检查一个目录不存在或为无链接的正规目录，并拒绝经祖先重定向到别处。
 * @param path 预期的绝对目录路径
 * @returns 存在合法目录时为 true；缺失时为 false
 */
export function checkedDirectory(path: string): boolean {
  const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (info === undefined) return false;
  if (!info.isDirectory() || !samePath(path, realpathSync.native(path))) {
    throw new CognitionError('storage', '工作区数据库目录不是原位普通目录');
  }
  return true;
}

/**
 * 确认普通文件原位且只有一个链接；同样用于 SQLite 将自动打开的辅助文件。
 * @param path 工作区存储目录内的绝对文件路径
 * @param ignoreUnsafe 仅枚举主库时跳过不安全的目录项；显式开库和检查辅助文件仍拒绝
 * @returns 文件身份；不存在或明确跳过时为 undefined
 */
export function checkedFile(path: string, ignoreUnsafe = false): BigIntStats | undefined {
  const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (info === undefined) return undefined;
  if (!info.isFile() || info.nlink !== 1n || !samePath(path, realpathSync.native(path))) {
    if (ignoreUnsafe) return undefined;
    throw new CognitionError('storage', '数据库文件或辅助文件不是原位普通单链接文件');
  }
  return info;
}

/**
 * 读取已检查文件的一小段格式头，并核对打开的仍是先前观察到的文件。
 * @param path 已通过普通文件检查的绝对路径
 * @param expected 打开前观察到的文件身份
 * @param length 仅读的格式头最大字节数
 */
function readHeader(path: string, expected: BigIntStats, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    if (!sameFile(expected, fstatSync(fd, { bigint: true }))) {
      throw new CognitionError('storage', '工作区数据库文件在打开时被替换');
    }
    const bytes = Buffer.alloc(length);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

/**
 * 在 SQLite 能读写已有数据库前，核对主库签名、应用标记与格式版本。
 * @param path 已检查的主库路径
 * @param expected 主库的文件身份
 */
function checkHeader(path: string, expected: BigIntStats): void {
  const bytes = readHeader(path, expected, 100);
  // 迁移可能尚在 WAL；这里只拒绝未知主库头，事务内再核对可见版本及对应结构。
  if (bytes.length !== 100 || !bytes.subarray(0, HEADER.length).equals(HEADER)
    || (bytes.readUInt32BE(60) !== LEGACY_SCHEMA_VERSION && bytes.readUInt32BE(60) !== SCHEMA_VERSION)
    || bytes.readUInt32BE(68) !== APPLICATION_ID) {
    throw new CognitionError('storage', '拒绝打开未知或不受支持的工作区数据库文件');
  }
}

/**
 * 排除与 SQLite 自管日志撞名的已有普通文件。可容纳 SQLite 的空文件和未初始化日志头；
 * 它只检查格式，不代替 SQLite 自身的校验，也不认证有本地写权限者提供的内容。
 * @param path 预期的辅助文件路径
 * @param suffix SQLite 自管文件的后缀
 * @param info 文件身份与长度
 */
function checkSidecar(path: string, suffix: string, info: BigIntStats): void {
  if (info.size === 0n) return;
  const bytes = readHeader(path, info, 32);
  let valid = false;
  if (suffix === '-wal' && bytes.length === 32) {
    const magic = bytes.readUInt32BE(0);
    valid = (magic === 0x377f0682 || magic === 0x377f0683) && bytes.readUInt32BE(4) === 3007000;
  } else if (suffix === '-shm' && bytes.length >= 4 && info.size % 32768n === 0n) {
    // WAL-index 的 32 KiB 分页、宿主字节序与可为零的初始化版本。
    valid = bytes.readUInt32BE(0) === 0 || bytes.readUInt32BE(0) === 3007000 || bytes.readUInt32LE(0) === 3007000;
  } else if (suffix === '-journal' && bytes.length >= 28) {
    const magic = bytes.readBigUInt64BE(0);
    valid = magic === 0xd9d505f920a163d7n || magic === 0n;
  }
  if (!valid) throw new CognitionError('storage', '拒绝打开已存在但不符合 SQLite 格式的辅助文件');
}

/**
 * 找到绑定工作区的存储目录路径；工作区根缺失与尚未建库存储目录是不同结果。
 * @param root 已校验的宿主工作区根
 */
export function storageDirectory(root: string): string {
  if (!checkedDirectory(root)) throw new CognitionError('storage', '宿主工作区根目录不存在');
  return join(root, '.converge');
}

/**
 * 开库前验证已有主库与 SQLite 自动打开的辅助文件，避免接管外来文件。
 * @param file 工作区内的绝对主库路径
 * @param main 已通过检查的主库身份；未预留路径时可缺失
 */
function checkDatabaseFiles(file: string, main: BigIntStats | undefined): void {
  if (main !== undefined) checkHeader(file, main);
  for (const suffix of SIDECARS) {
    const companion = file + suffix;
    const info = checkedFile(companion);
    if (info === undefined) continue;
    if (main === undefined) throw new CognitionError('storage', '数据库主文件缺失，但已存在同名辅助文件');
    checkSidecar(companion, suffix, info);
  }
}

/** 安全 ID 的主库候选；file 缺失表示未通过读库前的文件检查。 */
interface DatabaseCandidate { treeId: string; file?: string }

/**
 * 按树 ID 自然序枚举绑定目录的主库候选；只看一级，不创建、递归或打开链接。
 * @param root 已校验的宿主工作区根
 * @returns 候选供逐库校验已提交登记；工作区或目录读取失败时抛错
 */
export function* discoverDatabases(root: string): Generator<DatabaseCandidate> {
  const directory = storageDirectory(root);
  if (!checkedDirectory(directory)) return;

  const names = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(DATABASE_SUFFIX)) continue;
    const treeId = name.slice(0, -DATABASE_SUFFIX.length);
    if (isSafeTreeId(treeId)) names.push({ name, treeId, key: idKey(treeId) });
  }
  names.sort((a, b) => Buffer.compare(a.key, b.key));
  for (const { name, treeId } of names) {
    // 目录错误不是单库损坏，不能放进单候选的容错范围。
    if (!checkedDirectory(directory)) throw new CognitionError('storage', '工作区数据库目录在列举时消失');
    const path = join(directory, name);
    let file: string | undefined;
    try {
      const main = checkedFile(path, true);
      // 空文件可能是尚未完成初始化的预留位，不能用 SQLite 打开或列为树。
      if (main === undefined || main.size === 0n) continue;
      checkDatabaseFiles(path, main);
      file = path;
    } catch { /* 该候选无法读取，只把安全 ID 交给调用方。 */ }
    yield { treeId, file };
  }
}

/** 准备打开的路径；存在性只表示文件，树是否已自举以库内 tree_meta 为准。 */
export interface DatabaseLocation {
  file: string;
  present: boolean;
}

/**
 * 定位主库并检查工作区、主库及辅助文件，读时不创建目录。
 * @param root 已校验的宿主工作区根
 * @param name databaseName 生成的安全主库文件名
 * @param create 是否为自举预留存储目录
 * @returns 限定在 root/.converge 内的绝对主库路径及物理存在性
 */
export function locateDatabase(root: string, name: string, create: boolean): DatabaseLocation {
  const directory = storageDirectory(root);
  const file = join(directory, name);
  if (!checkedDirectory(directory)) {
    if (!create) return { file, present: false };
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!checkedDirectory(directory)) throw new CognitionError('storage', '工作区数据库目录未能创建');
  }
  const main = checkedFile(file);
  checkDatabaseFiles(file, main);
  return { file, present: main !== undefined };
}

/**
 * 独占预留缺失的主库路径，不打开或覆盖抢先出现的任何文件。
 * @param file locateDatabase 检查后的主库绝对路径
 * @returns 本次预留文件的身份，供最初的格式创建失败时核对
 */
export function claimDatabase(file: string): BigIntStats {
  const fd = openSync(file, 'wx', 0o600);
  try { return fstatSync(fd, { bigint: true }); }
  finally { closeSync(fd); }
}

/**
 * 首次建格式失败时把本次预留文件移到同目录的隔离名，保留证据而不占用目标树名。
 * @param file 本次创建且尚未写入树的主库路径
 * @param claimed 独占创建时取得的文件身份；不处理被替换或另有链接的文件
 */
export function preserveFailedInitialization(file: string, claimed: BigIntStats): void {
  const directory = dirname(file);
  if (!checkedDirectory(directory)) return;
  const current = checkedFile(file);
  if (current === undefined || !sameFile(current, claimed)) return;
  const quarantine = `${file}.uninitialized-${randomUUID()}`;
  // 初始化前并无这些辅助文件；关闭失败连接后，若还有本次日志，也一起保留不覆盖。
  for (const suffix of [...SIDECARS, '']) {
    const source = file + suffix;
    const target = quarantine + suffix;
    if (dirname(resolve(source)) !== directory || dirname(resolve(target)) !== directory
      || lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
      throw new CognitionError('storage', '不能安全隔离未完成的数据库文件');
    }
    if (checkedFile(source) !== undefined) renameSync(source, target);
  }
}
