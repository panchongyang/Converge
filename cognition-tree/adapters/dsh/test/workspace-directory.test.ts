/** 工作区根问题目录：隔离 SQLite 主库和事务实测，不接宿主或正式库。 */
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteTreeStore } from '../src/server/storage';
import { Connection } from '../src/server/storage/connection';
import { SQL } from '../src/server/storage/schema';

const local = fileURLToPath(new URL('../../../../.local-work/', import.meta.url));
const stores = new Set<SqliteTreeStore>();
const empty = { trees: [], unavailable: [] };

/** 分配仓库 .local-work 下的新工作区；不清理其中的测试文件。 */
function workspace(): string {
  mkdirSync(local, { recursive: true });
  return mkdtempSync(join(local, 'workspace-directory-'));
}

/**
 * 绑定仅供本用例使用且自动关闭的存储。
 * @param root 测试工作区绝对路径
 */
function store(root: string): SqliteTreeStore {
  const item = new SqliteTreeStore(root);
  stores.add(item);
  return item;
}

/**
 * 正常提交有正文与子节点的树，允许使用与树 ID 不同的既有根 ID。
 * @param storage 隔离存储
 * @param treeId 树 ID，亦为其文件名主体
 * @param rootId 实际根 ID
 * @param rootQuestion 实际根标题
 */
async function seed(storage: SqliteTreeStore, treeId: string, rootId: string, rootQuestion: string): Promise<void> {
  await storage.transact(treeId, 'createNew', (tx) => {
    tx.writeNode({ id: rootId, parentId: null, body: { title: rootQuestion, text: '不要读正文' }, origin: { kind: 'branch' } });
    tx.writeNode({ id: 'child', parentId: rootId, body: { title: '不是根' }, origin: { kind: 'branch' } });
  });
}

/** 用例之间释放连接与查询观察器，但保留隔离文件。 */
afterEach(async () => {
  vi.restoreAllMocks();
  try { await Promise.all([...stores].map((item) => item.close())); }
  finally { stores.clear(); }
});

/** 返回一个释放前保持测试写事务的屏障。 */
function barrier(): { pending: Promise<void>; release: () => void } {
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  return { pending, release };
}

describe('SQLite 工作区根问题目录', () => {
  it('缺存储目录时返回空且不创建；缺工作区或目录异常报错', async () => {
    const root = workspace();
    const storage = store(root);
    await expect(storage.listTrees()).resolves.toEqual(empty);
    await expect(store(join(root, 'missing-workspace')).listTrees()).rejects.toMatchObject({ code: 'storage' });
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(join(root, '.converge'), '不是存储目录', { flag: 'wx' });
    await expect(storage.listTrees()).rejects.toMatchObject({ code: 'storage' });
    await storage.close();
    await expect(storage.listTrees()).rejects.toMatchObject({ code: 'storage' });
  });

  it('从本工作区真实根按稳定 ID 排序，不读取分支正文或历史', async () => {
    const root = workspace();
    const writer = store(root);
    await seed(writer, 'T10', 'T10', '十号问题？');
    await seed(writer, 'T2', 'imported.root', '保留既有根问题？');
    await writer.close();
    const other = store(workspace());
    await seed(other, 'T2', 'other-root', '别处同名');

    const files = ['T2', 'T10'].map((id) => join(root, '.converge', `${id}.sqlite`));
    const bytes = files.map((file) => readFileSync(file));
    const get = vi.spyOn(Connection.prototype, 'get');
    await expect(store(root).listTrees()).resolves.toEqual({
      trees: [
        { treeId: 'T2', rootId: 'imported.root', rootQuestion: '保留既有根问题？' },
        { treeId: 'T10', rootId: 'T10', rootQuestion: '十号问题？' },
      ],
      unavailable: [],
    });
    expect(get.mock.calls).toEqual([
      ['PRAGMA user_version'], ['PRAGMA application_id'], [SQL.treeMeta],
      ['SELECT 1 FROM node_archive WHERE node_id = ?', 'imported.root'], [SQL.rootQuestion, 'imported.root'],
      ['PRAGMA user_version'], ['PRAGMA application_id'], [SQL.treeMeta],
      ['SELECT 1 FROM node_archive WHERE node_id = ?', 'T10'], [SQL.rootQuestion, 'T10'],
    ]);
    // SQLite 可管理自己的 WAL/SHM；目录读取不改变主库或 schema，也不建立其它业务库。
    expect(files.map((file) => readFileSync(file))).toEqual(bytes);
    expect(readdirSync(join(root, '.converge')).filter((name) => name.endsWith('.sqlite')).sort()).toEqual(['T10.sqlite', 'T2.sqlite']);
  });

  it('不列出未提交自举，提交后立即看见尚在 WAL 的根', async () => {
    const root = workspace();
    const storage = store(root);
    const entered = barrier();
    const finish = barrier();
    const writing = storage.transact('T1', 'createNew', async (tx) => {
      tx.writeNode({ id: 'root', parentId: null, body: { title: '提交之后才可见' }, origin: { kind: 'branch' } });
      entered.release();
      await finish.pending;
    });
    const file = join(root, '.converge', 'T1.sqlite');
    let held: DatabaseSync | undefined;
    try {
      let main: Buffer;
      try {
        await Promise.race([entered.pending, writing]);
        main = readFileSync(file);
        // 固定尚无登记的快照，防止写连接关闭时把已提交帧合并到主库。
        held = new DatabaseSync(file, { readOnly: true });
        held.exec('BEGIN');
        expect(held.prepare(SQL.treeMeta).get()).toBeUndefined();
        await expect(storage.listTrees()).resolves.toEqual(empty);
      } finally {
        finish.release();
        await writing;
      }
      expect(readFileSync(file)).toEqual(main!);
      await expect(storage.listTrees()).resolves.toEqual({
        trees: [{ treeId: 'T1', rootId: 'root', rootQuestion: '提交之后才可见' }], unavailable: [],
      });
      expect(held?.prepare(SQL.treeMeta).get()).toBeUndefined();
    } finally { held?.close(); }
  });

  it('坏库只报告安全 ID，不阻断其它树，也不接管空文件、外来库或失败自举', async () => {
    const root = workspace();
    const storage = store(root);
    await seed(storage, 'Good', 'root', '可读的根');
    await seed(storage, 'Bad2', 'root', '登记指向子节点');
    await seed(storage, 'Bad10', 'root', '登记与文件错配');
    const failure = new Error('故意中止自举');
    await expect(storage.transact('Failed', 'createNew', (tx) => {
      tx.writeNode({ id: 'root', parentId: null, body: { title: '未提交' }, origin: { kind: 'branch' } });
      throw failure;
    })).rejects.toBe(failure);
    const directory = join(root, '.converge');
    const fixtures = ['Bad2', 'Bad10', 'Foreign'].map((id) => join(directory, `${id}.sqlite`));
    const edits = [
      "UPDATE tree_meta SET root_id = 'child'",
      "UPDATE tree_meta SET tree_id = 'Other'",
      "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('保留')",
    ];
    for (const [i, file] of fixtures.entries()) {
      const db = new DatabaseSync(file);
      try { db.exec(edits[i]); }
      finally { db.close(); }
    }
    const emptyFile = join(directory, 'Reserved.sqlite');
    writeFileSync(emptyFile, '', { flag: 'wx' });
    expect(readFileSync(emptyFile)).toHaveLength(0);
    const bytes = [...fixtures, emptyFile].map((file) => readFileSync(file));
    await expect(storage.listTrees()).resolves.toEqual({
      trees: [{ treeId: 'Good', rootId: 'root', rootQuestion: '可读的根' }], unavailable: ['Bad2', 'Bad10', 'Foreign'],
    });
    expect([...fixtures, emptyFile].map((file) => readFileSync(file))).toEqual(bytes);
    expect(readdirSync(directory)).not.toContain('Foreign.sqlite-wal');
    expect(readdirSync(directory)).not.toContain('Reserved.sqlite-wal');
  });

  it('不递归、打开链接或把 sidecar 链接交给 SQLite', async () => {
    const root = workspace();
    const outside = workspace();
    const directory = join(root, '.converge');
    const outsideDirectory = join(outside, '.converge');
    const storage = store(root);
    const other = store(outside);
    await seed(other, 'Symbolic', 'root', '不可跨工作区读取');
    await seed(other, 'Hard', 'root', '不可读硬链接');
    await seed(storage, 'Sidecar', 'root', '不能打开链接日志');
    await seed(storage, 'Good', 'root', '同目录的可读树');
    const nested = join(directory, 'Nested.sqlite');
    mkdirSync(nested);
    await seed(store(nested), 'Hidden', 'root', '不可递归读取');
    const victim = join(outside, 'outside-journal');
    writeFileSync(victim, '保留原样', { flag: 'wx' });
    symlinkSync(join(outsideDirectory, 'Symbolic.sqlite'), join(directory, 'Symbolic.sqlite'), 'file');
    linkSync(join(outsideDirectory, 'Hard.sqlite'), join(directory, 'Hard.sqlite'));
    symlinkSync(victim, join(directory, 'Sidecar.sqlite-journal'), 'file');
    writeFileSync(join(directory, 'bad id.sqlite'), '不安全的 ID', { flag: 'wx' });
    writeFileSync(join(directory, 'Orphan.sqlite-wal'), '', { flag: 'wx' });
    await expect(storage.listTrees()).resolves.toEqual({
      trees: [{ treeId: 'Good', rootId: 'root', rootQuestion: '同目录的可读树' }], unavailable: ['Sidecar'],
    });
    expect(readFileSync(victim, 'utf8')).toBe('保留原样');
    expect(readdirSync(directory)).not.toContain('Orphan.sqlite');

    const linkedRoot = workspace();
    symlinkSync(outsideDirectory, join(linkedRoot, '.converge'), 'junction');
    await expect(store(linkedRoot).listTrees()).rejects.toMatchObject({ code: 'storage' });
    symlinkSync(outside, join(linkedRoot, 'linked-workspace'), 'junction');
    await expect(store(join(linkedRoot, 'linked-workspace')).listTrees()).rejects.toMatchObject({ code: 'storage' });
  });
});
