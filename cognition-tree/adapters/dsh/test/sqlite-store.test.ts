/** 隔离工作区中的真正 SQLite 文件、事务、快照、索引和真实内核接线；不接运行中的 DSH。 */
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernel } from '@cognition-tree/kernel/catalog';
import type { CognitionNode, FormationRevision, ImportedRevision, ReadSnapshot, Revision, WriteTransaction } from '@cognition-tree/kernel/types';
import { parseAiInput } from '../src/server/host/input';
import { SqliteTreeStore } from '../src/server/storage';
import { Connection } from '../src/server/storage/connection';
import { idKey, timeKey } from '../src/server/storage/order-keys';
import { APPLICATION_ID, SCHEMA_VERSION, SQL } from '../src/server/storage/schema';

const local = fileURLToPath(new URL('../../../../.local-work/', import.meta.url));
const open = new Set<SqliteTreeStore>();
const at = '2026-11-20T08:00:00Z';

/** 在仓库 .local-work 下创建独占的测试工作区；测试不删除或改写既有目录。 */
function workspace(): string {
  mkdirSync(local, { recursive: true });
  return mkdtempSync(join(local, 'sqlite-store-'));
}

/**
 * 创建本测试负责关闭的存储。
 * @param root 独占测试工作区
 * @param onCommit 可选提交观察器
 */
function store(root: string, onCommit?: ConstructorParameters<typeof SqliteTreeStore>[1]): SqliteTreeStore {
  const result = new SqliteTreeStore(root, onCommit);
  open.add(result);
  return result;
}

/**
 * 生成节点夹具，默认无导入确认标记。
 * @param id 节点 ID
 * @param parentId 真实父节点；根为 null
 * @param title 可选简短标题，缺省为 ID
 */
function node(id: string, parentId: string | null, title = id): CognitionNode {
  return { id, parentId, body: { title }, origin: { kind: 'branch' } };
}

/**
 * 生成一条可追加的形成修订。
 * @param id 修订 ID
 * @param by 形成记录的日常执行者
 * @param nodeIds 关联的节点和效果
 * @param time 可选实际发生时间
 */
function formation(id: string, by: 'human' | 'ai', nodeIds: string[], time = at): FormationRevision {
  return { id, nodeIds, by, at: time, kind: 'formation', summary: id, detail: {
    action: 'addBranch', effects: nodeIds.map((nodeId) => ({ nodeId, afterState: 'keep' })),
  } };
}

/** 关闭全部测试连接，保留唯一工作区内的 SQLite 文件作为本机试验产物。 */
afterEach(async () => {
  try { await Promise.all([...open].map((item) => item.close())); }
  finally { open.clear(); }
});

/**
 * 创建一棵最小树，可供后续事务和重开检查。
 * @param storage 所属测试存储
 */
async function initialize(storage: SqliteTreeStore): Promise<void> {
  await storage.transact('T1', 'createNew', (tx) => tx.writeNode(node('root', null)));
}

/** 返回一对仅由测试控制的异步屏障，以保持真实写事务打开。 */
function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/**
 * 收集真正提交的通知，备查 stamp 与修订。
 * @param root 隔离工作区
 */
function observe(root: string) {
  const changes: Array<{ treeId: string; stamp: number; revisions: Revision[] }> = [];
  return { storage: store(root, (event) => { changes.push(event); }), changes };
}

/**
 * 从稳定末项 ID 逐页取出历史。
 * @param snap 已打开快照
 * @param nodeId 目标节点或整树的 null
 */
async function allHistory(snap: ReadSnapshot, nodeId: string | null): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const rows = await snap.listRevisions(nodeId, cursor, 2);
    if (rows.length === 0) return ids;
    ids.push(...rows.map(({ id }) => id));
    cursor = rows[rows.length - 1].id;
  }
  throw new Error('分页未推进');
}

describe('SQLite 文件边界与事务', () => {
  it('不因读缺失树建库，按工作区隔离同名 T1，重开仍有提交', async () => {
    const root = workspace();
    const storage = store(root);
    const otherRoot = workspace();
    const other = store(otherRoot);
    const work = vi.fn();
    await expect(storage.openRead('T1')).rejects.toMatchObject({ code: 'missing' });
    await expect(storage.transact('T1', 'existing', work)).rejects.toMatchObject({ code: 'missing' });
    expect(work).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
    await initialize(storage);
    expect(existsSync(join(root, '.converge', 'T1.sqlite'))).toBe(true);
    await expect(storage.openRead('T2')).rejects.toMatchObject({ code: 'missing' });
    expect(existsSync(join(root, '.converge', 'T2.sqlite'))).toBe(false);
    await expect(other.openRead('T1')).rejects.toMatchObject({ code: 'missing' });
    await other.transact('T1', 'createNew', (tx) => tx.writeNode(node('different', null)));
    await storage.close();
    const reopened = store(root);
    const snap = await reopened.openRead('T1');
    expect([snap.stamp, snap.rootId, (await other.openRead('T1')).rootId]).toEqual([1, 'root', 'different']);
    await expect(reopened.transact('T1', 'createNew', work)).rejects.toMatchObject({ code: 'invalid' });
    if (process.platform === 'win32') await expect(reopened.openRead('t1')).rejects.toMatchObject({ code: 'invalid' });
    expect(work).not.toHaveBeenCalled();
  });

  it('拒绝路径、保留设备名、URI 与 alternate stream，保持目录为空', async () => {
    const root = workspace();
    const storage = store(root);
    const ids = ['../outside', 'T1/../../outside', 'T1\\other', '..', '.T1', 'T1.', 'T1:', 'T1:ads', 'T1\n',
      'T1\0x', 'file:T1?mode=memory', ':memory:', 'NUL', 'com1', 'LPT9', 'T'.repeat(65)];
    for (const id of ids) {
      await expect(storage.openRead(id)).rejects.toMatchObject({ code: 'invalid' });
      await expect(storage.transact(id, 'createNew', vi.fn())).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('拒绝目录链接、文件链接、硬链接以及 SQLite 自动访问的链接辅助文件', async () => {
    const real = workspace();
    const root = workspace();
    symlinkSync(real, join(root, '.converge'), 'junction');
    await expect(store(root).openRead('T1')).rejects.toMatchObject({ code: 'storage' });
    await expect(initialize(store(root))).rejects.toMatchObject({ code: 'storage' });
    expect(readdirSync(real)).toEqual([]);

    const storage = store(real);
    await initialize(storage);
    await storage.close();
    const victim = join(real, '.converge', 'T1.sqlite');
    const testing = workspace();
    const directory = join(testing, '.converge');
    mkdirSync(directory);
    symlinkSync(victim, join(directory, 'Sym.sqlite'), 'file');
    linkSync(victim, join(directory, 'Hard.sqlite'));
    const candidate = store(testing);
    for (const id of ['Sym', 'Hard']) {
      await expect(candidate.openRead(id)).rejects.toMatchObject({ code: 'storage' });
      await expect(candidate.transact(id, 'createNew', vi.fn())).rejects.toMatchObject({ code: 'storage' });
    }

    const walRoot = workspace();
    const walStore = store(walRoot);
    await initialize(walStore);
    const sentinel = join(walRoot, 'outside.sqlite');
    writeFileSync(sentinel, '必须原样保留');
    linkSync(sentinel, join(walRoot, '.converge', 'T1.sqlite-wal'));
    await expect(walStore.openRead('T1')).rejects.toMatchObject({ code: 'storage' });
    await expect(walStore.transact('T1', 'existing', vi.fn())).rejects.toMatchObject({ code: 'storage' });
    expect(readFileSync(sentinel, 'utf8')).toEqual('必须原样保留');
    const orphan = join(walRoot, '.converge', 'Missing.sqlite-shm');
    writeFileSync(orphan, '非主库所属');
    await expect(walStore.transact('Missing', 'createNew', vi.fn())).rejects.toMatchObject({ code: 'storage' });
    expect(existsSync(join(walRoot, '.converge', 'Missing.sqlite'))).toBe(false);
  });

  it('不接管目录、未知文件或存在但格式不符的 SQLite 库', async () => {
    const root = workspace();
    const directory = join(root, '.converge');
    mkdirSync(directory);
    mkdirSync(join(directory, 'Directory.sqlite'));
    writeFileSync(join(directory, 'Text.sqlite'), 'not SQLite');
    writeFileSync(join(directory, 'Empty.sqlite'), '');
    const foreign = new DatabaseSync(join(directory, 'Foreign.sqlite'));
    foreign.exec('CREATE TABLE unrelated (message TEXT); INSERT INTO unrelated VALUES (\'保留\');');
    foreign.close();
    const wrong = new DatabaseSync(join(directory, 'Wrong.sqlite'));
    wrong.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; CREATE TABLE unrelated (value TEXT)`);
    wrong.close();
    const storage = store(root);
    for (const id of ['Directory', 'Text', 'Empty', 'Foreign', 'Wrong']) {
      const path = join(directory, `${id}.sqlite`);
      const bytes = id === 'Directory' ? undefined : readFileSync(path);
      await expect(storage.openRead(id)).rejects.toMatchObject({ code: 'storage' });
      await expect(storage.transact(id, 'createNew', vi.fn())).rejects.toMatchObject({ code: 'storage' });
      if (bytes !== undefined) expect(readFileSync(path)).toEqual(bytes);
      expect(existsSync(`${path}-wal`)).toBe(false);
    }
  });

  it('不把撞名的普通文件当成 SQLite 自管辅助文件', async () => {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const root = workspace();
      const storage = store(root);
      await initialize(storage);
      const companion = join(root, '.converge', `T1.sqlite${suffix}`);
      const contents = Buffer.from('与 SQLite 同名但不属于它的文件。'.repeat(5));
      writeFileSync(companion, contents, { flag: 'wx' });
      await expect(storage.openRead('T1')).rejects.toMatchObject({ code: 'storage' });
      await expect(storage.transact('T1', 'existing', vi.fn())).rejects.toMatchObject({ code: 'storage' });
      expect(readFileSync(companion)).toEqual(contents);
    }
  });

  it('初始化的 SQLite SQL 失败只隔离本次空库，原名可重新创建', async () => {
    const root = workspace();
    const { storage, changes } = observe(root);
    const fault = vi.spyOn(Connection.prototype, 'initialize').mockImplementationOnce(function (this: Connection) {
      // 故障缝只影响首次格式建表；原生 SQLite 因重复 DDL 返回错误，实际走关闭和回滚。
      this.exec('BEGIN IMMEDIATE; CREATE TABLE actual_write (id INTEGER); CREATE TABLE actual_write (id INTEGER)');
    });
    try {
      await expect(initialize(storage)).rejects.toMatchObject({ code: 'storage', cause: { errcode: 1 } });
      const activeFiles = readdirSync(join(root, '.converge'));
      expect(activeFiles).not.toContain('T1.sqlite');
      expect(activeFiles.some((name) => name.startsWith('T1.sqlite.uninitialized-'))).toBe(true);
      expect(changes).toEqual([]);
      await expect(storage.openRead('T1')).rejects.toMatchObject({ code: 'missing' });
    } finally { fault.mockRestore(); }
    await initialize(storage);
    expect((await storage.openRead('T1')).stamp).toBe(1);
  });

  it('失败自举不发布登记；关闭、重开后仍可重试', async () => {
    const root = workspace();
    const { storage, changes } = observe(root);
    const error = new Error('work 中止');
    let escaped: WriteTransaction | undefined;
    await expect(storage.transact('T1', 'createNew', async (tx) => {
      escaped = tx;
      tx.writeNode(node('aborted', null));
      tx.appendRevision(formation('r1', 'ai', ['aborted']));
      expect(await tx.readNode('aborted')).not.toBeNull();
      expect(await tx.readRevision('r1')).not.toBeNull();
      throw error;
    })).rejects.toBe(error);
    await expect(escaped?.readNode('aborted')).rejects.toMatchObject({ code: 'storage' });
    await expect(storage.openRead('T1')).rejects.toMatchObject({ code: 'missing' });
    expect(changes).toEqual([]);
    await storage.close();
    const restarted = observe(root);
    await expect(restarted.storage.transact('T1', 'existing', vi.fn())).rejects.toMatchObject({ code: 'missing' });
    await initialize(restarted.storage);
    const snap = await restarted.storage.openRead('T1');
    expect(snap.stamp).toBe(1);
    expect(await snap.readNode('aborted')).toBeNull();
    expect(await snap.readRevision('r1')).toBeNull();
    expect(restarted.changes).toEqual([{ treeId: 'T1', stamp: 1, revisions: [] }]);
  });

  it('真实 SQLite COMMIT 延迟外键失败，回滚自举和日常修订且不通知', async () => {
    const root = workspace();
    const { storage, changes } = observe(root);
    const end = vi.fn();
    /**
     * 制造写语句成功、只在 COMMIT 报错的孤儿引用。
     * @param tx 已开的事务
     * @param creating 自举事务额外写根
     */
    const bad = (tx: WriteTransaction, creating: boolean) => {
      if (creating) tx.writeNode(node('root', null));
      tx.writeNode({ ...node('r-new', 'root'), currentChange: { revisionId: 'rev1', by: 'ai' } });
      tx.appendRevision(formation('rev1', 'ai', ['r-new']));
      tx.writeRef({ id: 'ref1', from: 'r-new', kind: 'example', target: { nodeId: 'not-in-database' } });
      end();
    };
    await expect(storage.transact('T1', 'createNew', (tx) => bad(tx, true)))
      .rejects.toMatchObject({ code: 'storage', cause: { errcode: 787 } }); // SQLITE_CONSTRAINT_FOREIGNKEY
    expect(end).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([]);
    await expect(storage.openRead('T1')).rejects.toMatchObject({ code: 'missing' });
    await initialize(storage);
    await expect(storage.transact('T1', 'existing', (tx) => bad(tx, false)))
      .rejects.toMatchObject({ code: 'storage', cause: { errcode: 787 } });
    expect(end).toHaveBeenCalledTimes(2);
    const snap = await storage.openRead('T1');
    expect(snap.stamp).toBe(1);
    expect(await snap.readNode('r-new')).toBeNull();
    expect(await snap.readRevision('rev1')).toBeNull();
    expect(await snap.listRefsFrom('r-new', null, 10)).toEqual([]);
    expect(await snap.listUnconfirmed(['ai'], null, 10)).toEqual([]);
    expect(changes).toEqual([{ treeId: 'T1', stamp: 1, revisions: [] }]);
    await snap.close();
    await storage.close();
    const reopened = store(root);
    const good = await reopened.openRead('T1');
    expect([good.stamp, await good.readRevision('rev1')]).toEqual([1, null]);
    await reopened.transact('T1', 'existing', (tx) => tx.writeNode(node('r-new', 'root')));
    await expect((await reopened.openRead('T1')).readNode('r-new')).resolves.not.toBeNull();
  });

  it('write 自己捕获的 SQL 失败也不能发布部分提交；监听者失败不让成功变成失败', async () => {
    const root = workspace();
    const onCommit = vi.fn(() => { throw new Error('独立观察器失败'); });
    const storage = store(root, onCommit);
    await initialize(storage);
    await expect(storage.transact('T1', 'existing', (tx) => {
      tx.writeNode(node('partial', 'root'));
      try { tx.writeRef({ id: 'bad-ref', from: 'root', kind: 'conflict', target: {} } as never); }
      catch { /* 证明捕获 SQL CHECK 失败不能使其他写入提交。 */ }
    })).rejects.toMatchObject({ code: 'storage', cause: { errcode: 275 } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const snap = await storage.openRead('T1');
    expect(snap.stamp).toBe(1);
    expect(await snap.readNode('partial')).toBeNull();
  });

  it('WAL 快照跨未提交和多次提交不混版本，写同树顺序不乱', async () => {
    const { storage, changes } = observe(workspace());
    await initialize(storage);
    const first = await storage.openRead('T1');
    const started = barrier();
    const release = barrier();
    const revision = formation('r1', 'ai', ['child']);
    const writing = storage.transact('T1', 'existing', async (tx) => {
      tx.writeNode({ ...node('child', 'root'), currentChange: { revisionId: 'r1', by: 'ai' } });
      tx.writeRef({ id: 'f1', from: 'root', kind: 'example', target: { nodeId: 'child' } });
      tx.appendRevision(revision);
      started.release();
      await release.promise;
      return '写完';
    });
    await started.promise;
    const during = await storage.openRead('T1');
    const next = storage.transact('T1', 'existing', async (tx) => {
      const child = await tx.readNode('child');
      expect(child).not.toBeNull();
      if (child !== null) tx.writeNode({ ...child, confirmation: 'humanConfirmed' });
    });
    expect(changes.map(({ stamp }) => stamp)).toEqual([1]);
    expect(during.stamp).toBe(1);
    expect(await during.readNode('child')).toBeNull();
    release.release();
    await expect(writing).resolves.toBe('写完');
    await next;
    const latest = await storage.openRead('T1');
    expect(latest.stamp).toBe(3);
    expect(await latest.readNodeRow('child')).toMatchObject({ confirmation: 'humanConfirmed' });
    expect(await latest.listRefsTo('child', null, 2)).toHaveLength(1);
    expect(await latest.listUnconfirmed(['ai'], null, 2)).toEqual([]);
    for (const snap of [first, during]) {
      expect(snap.stamp).toBe(1);
      expect(await snap.listChildren('root', null, 2)).toEqual([]);
      expect(await snap.listRefsTo('child', null, 2)).toEqual([]);
      expect(await snap.listRevisions(null, null, 2)).toEqual([]);
    }
    expect(changes).toEqual([
      { treeId: 'T1', stamp: 1, revisions: [] }, { treeId: 'T1', stamp: 2, revisions: [revision] },
      { treeId: 'T1', stamp: 3, revisions: [] },
    ]);
    await storage.close();
    await expect(during.readNode('root')).rejects.toMatchObject({ code: 'storage' });
    await expect(storage.openRead('T1')).rejects.toMatchObject({ code: 'storage' });
    await during.close();
    await storage.close();
  });

  it('关闭挂起写入时立即回滚并释放连接，不等待工作回调', async () => {
    const root = workspace();
    const { storage, changes } = observe(root);
    await initialize(storage);
    const started = barrier();
    const release = barrier();
    const writing = storage.transact('T1', 'existing', async (tx) => {
      tx.writeNode(node('not-committed', 'root'));
      started.release();
      await release.promise;
      tx.writeNode(node('escaped', 'root'));
    });
    await started.promise;
    const result = expect(writing).rejects.toMatchObject({ code: 'storage' });
    await storage.close();
    const reopened = store(root);
    const snap = await reopened.openRead('T1');
    expect([snap.stamp, await snap.readNode('not-committed')]).toEqual([1, null]);
    await reopened.transact('T1', 'existing', (tx) => tx.writeNode(node('available', 'root')));
    release.release();
    await result;
    expect(changes).toEqual([{ treeId: 'T1', stamp: 1, revisions: [] }]);
  });
});

describe('SQLite 自然序、真实时间、确认与增量查询', () => {
  it('真实内核按当前视图版本写入；过期新增与决定不改树、历史或通知', async () => {
    const { storage, changes } = observe(workspace());
    const kernel = createKernel({ store: storage, clock: { now: () => at } });
    const treeId = 'T1';
    await kernel.dispatch('ai', 'createTree', { treeId, rootQuestion: '从当前树判断' });
    const view = () => kernel.dispatch('ai', 'readView', {
      treeId, focus: { root: true },
      expand: { subtreeDepth: 'leaf', jumpHops: 0, direction: 'out', jumpFrom: 'anchor', afterJumpDepth: 0 },
      budget: { maxScans: 100, maxNodes: 10, maxBytes: 8000 }, onLimit: 'exact', includeDetails: true,
    });
    const history = () => kernel.dispatch('ai', 'readHistory', { treeId, limit: 10 });
    const add = { treeId, placement: { parentId: treeId, kind: 'branch' }, draft: { body: { title: '新分支' }, state: 'open', refs: [] } };
    const { stamp: expectedStamp } = await view();
    const nodeId = await kernel.dispatch('ai', 'addBranch', parseAiInput('addBranch', { ...add, expectedStamp }));
    const before = await view();
    const beforeHistory = await history();
    const decide = { treeId, nodeId, decision: { type: 'setOpenOrKeep', state: 'keep', reason: '已核对' } };
    const stale = { code: 'invalid', message: /重新读取.*重新判断/ };
    expect(before.stamp).toBe(expectedStamp + 1);
    expect(beforeHistory.items).toHaveLength(2);
    await expect(kernel.dispatch('ai', 'addBranch', parseAiInput('addBranch', { ...add, expectedStamp }))).rejects.toMatchObject(stale);
    await expect(kernel.dispatch('ai', 'decideNode', parseAiInput('decideNode', { ...decide, expectedStamp })))
      .rejects.toMatchObject(stale);
    expect(() => parseAiInput('createTree', { treeId, rootQuestion: '非已有树写入', expectedStamp })).toThrow();
    expect(await view()).toEqual(before);
    expect(await history()).toEqual(beforeHistory);
    expect(changes.map(({ stamp }) => stamp)).toEqual([expectedStamp, before.stamp]);

    const current = await view();
    await expect(kernel.dispatch('ai', 'decideNode', parseAiInput('decideNode', { ...decide, expectedStamp: current.stamp })))
      .resolves.toBe(nodeId);
    expect((await kernel.dispatch('ai', 'readNode', { treeId, nodeId })).node).toMatchObject({ state: 'keep', confirmation: 'unconfirmed' });
    expect((await history()).items).toHaveLength(3);
    expect(changes.map(({ stamp }) => stamp)).toEqual([expectedStamp, current.stamp, current.stamp + 1]);
  });

  it('按自然 ID 有界读轻行和两向引用；历史以真实时间和自然修订 ID 翻页', async () => {
    const storage = store(workspace());
    await storage.transact('T1', 'createNew', (tx) => {
      tx.writeNode(node('root', null));
      tx.writeNode({ ...node('T1.10', 'root'), body: { title: '十', text: '长正文', basis: '' } });
      tx.writeNode(node('T1.2', 'root'));
      tx.writeNode(node('T1.01', 'root'));
      tx.writeNode(node('T1.2.10', 'T1.2'));
      tx.writeRef({ id: 'f10', kind: 'premise', from: 'root', target: { nodeId: 'T1.10', part: '状态' } });
      tx.writeRef({ id: 'f2', kind: 'example', from: 'root', target: { nodeId: 'T1.10' } });
      tx.writeRef({ id: 'f3', kind: 'example', from: 'root', target: { doc: '文档.md', part: '出处' } });
      const entries: Array<[string, string]> = [
        ['r2', at], ['r10', '2026-11-20T16:00:00.000+08:00'], ['r3', '2026-11-20T07:59:59.999999999Z'],
        ['r1', '2026-11-20T10:00:00+0300'], ['r11', '2026-11-20'], ['r12', '未知'], ['r20', '2026-11-20T08:00:00.0000000001Z'],
      ];
      for (const [id, occurred] of entries) {
        const item: ImportedRevision = { id, at: occurred, by: 'import', kind: 'formation',
          nodeIds: id === 'r12' ? ['root'] : ['root', 'T1.2', 'T1.2'], summary: id, source: '原史料' };
        tx.appendRevision(item);
      }
    });
    const snap = await storage.openRead('T1');
    expect((await snap.listChildren('root', null, 2)).map(({ id }) => id)).toEqual(['T1.2', 'T1.01']);
    expect(await snap.listChildren('root', 'T1.01', 1)).toEqual([{ id: 'T1.10', parentId: 'root', title: '十', origin: { kind: 'branch' } }]);
    expect((await snap.readNode('T1.10'))?.body).toEqual({ title: '十', text: '长正文', basis: '' });
    expect((await snap.listRefsFrom('root', null, 2)).map(({ id }) => id)).toEqual(['f2', 'f3']);
    expect(await snap.listRefsFrom('root', 'f2', 1)).toEqual([
      { id: 'f3', kind: 'example', from: 'root', target: { doc: '文档.md', part: '出处' } },
    ]);
    expect((await snap.listRefsTo('T1.10', null, 1)).map(({ id }) => id)).toEqual(['f2']);
    expect(await snap.listRefsTo('T1.10', 'f2', 2)).toEqual([
      { id: 'f10', kind: 'premise', from: 'root', target: { nodeId: 'T1.10', part: '状态' } },
    ]);
    const order = ['r20', 'r10', 'r2', 'r3', 'r1', 'r11', 'r12'];
    expect(await allHistory(snap, null)).toEqual(order);
    expect(await allHistory(snap, 'T1.2')).toEqual(order.slice(0, -1));
    expect(await snap.readRevision('r11')).toMatchObject({ at: '2026-11-20', nodeIds: ['root', 'T1.2', 'T1.2'], source: '原史料' });
    await expect(snap.listRevisions(null, 'not-here', 2)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('真实内核替代、部分失效、去重确认以及混合来源分页', async () => {
    const { storage, changes } = observe(workspace());
    const kernel = createKernel({ store: storage, clock: { now: () => at } });
    const treeId = 'T1';
    const old = { ...node('old', 'root'), state: 'keep' as const, confirmation: 'humanConfirmed' as const };
    /**
     * 构造明确未确认的导入判断。
     * @param id 种子节点 ID
     */
    const pending = (id: string) => ({ ...node(id, 'root'), confirmation: 'unconfirmed' as const });
    await kernel.dispatch('human', 'bootstrapTree', { seed: {
      treeId, rootId: 'root', nodes: [node('root', null), old, pending('p10'), pending('p2')], refs: [], history: [],
    } });
    const candidate = await kernel.dispatch('ai', 'addBranch', {
      treeId, placement: { replacesId: 'old' }, draft: { body: { title: '候选' }, state: 'open', refs: [] },
    });
    await kernel.dispatch('ai', 'decideNode', {
      treeId, nodeId: candidate, decision: { type: 'applyReplacement', reason: '更完整', reviveWhen: '出现反例' },
    });
    const replacement = changes[2].revisions[0].id;
    const { items: replaced } = await kernel.dispatch('human', 'readUnconfirmed', { treeId, by: ['ai'], limit: 10 });
    expect(replaced).toEqual([{ revisionId: replacement, at, by: 'ai', summary: changes[2].revisions[0].summary,
      nodeIds: [candidate, 'old'] }]);
    await kernel.dispatch('human', 'decideNode', {
      treeId, nodeId: candidate, decision: { type: 'setOpenOrKeep', state: 'keep', reason: '独立后续变化' },
    });
    const newer = changes[3].revisions[0].id;
    const first = await kernel.dispatch('human', 'readUnconfirmed', { treeId, by: ['import', 'human', 'ai'], limit: 1 });
    expect(first).toMatchObject({ items: [{ revisionId: newer, nodeIds: [candidate] }], next: { revisionId: newer } });
    const second = await kernel.dispatch('human', 'readUnconfirmed', {
      treeId, by: ['ai', 'human', 'import'], limit: 2, after: first.next,
    });
    expect(second).toMatchObject({ items: [{ revisionId: replacement, nodeIds: ['old'] }, { seedNodeId: 'p2' }], next: { seedNodeId: 'p2' } });
    await expect(kernel.dispatch('human', 'readUnconfirmed', { treeId, by: ['ai', 'import'], limit: 2, after: second.next }))
      .resolves.toEqual({ items: [{ seedNodeId: 'p10', title: 'p10' }] });
    const target = { revisionId: replacement };
    await kernel.dispatch('human', 'confirm', { treeId, target });
    await expect(kernel.dispatch('human', 'confirm', { treeId, target })).rejects.toMatchObject({ code: 'invalid' });
    const snap = await storage.openRead('T1');
    expect(await snap.readNode('old')).toMatchObject({ body: old.body, confirmation: 'humanConfirmed', state: 'prune' });
    expect(await snap.readNode(candidate)).toMatchObject({ confirmation: 'unconfirmed', currentChange: { revisionId: newer } });
    expect(await snap.listUnconfirmed(['ai'], null, 10)).toEqual([]);
    expect(await snap.listUnconfirmed(['human'], null, 10)).toHaveLength(1);
  });

  it('用实际查询计划和 5 MB 以上库验证索引与高频增量写', async () => {
    const root = workspace();
    const storage = store(root);
    const size = 2600;
    const fanout = 900;
    const text = '正文不应被节点轻行读取。'.repeat(100);
    const start = performance.now();
    await storage.transact('T1', 'createNew', (tx) => {
      tx.writeNode(node('root', null));
      for (let i = 1; i <= size; i += 1) {
        const id = `n${i}`;
        const rev = `r${i}`;
        const by = i % 2 === 0 ? 'human' : 'ai';
        tx.writeNode({ ...node(id, 'root'), body: { title: id, text }, state: 'keep',
          currentChange: { by, revisionId: rev }, confirmation: i % 10 === 1 ? 'unconfirmed' : 'humanConfirmed' });
        tx.appendRevision(formation(rev, by, ['root', id]));
        if (i <= fanout) tx.writeRef({ id: `f${i}`, from: 'root', kind: 'example', target: { nodeId: 'n1' } });
      }
      tx.writeNode({ ...node('seed1', 'root'), confirmation: 'unconfirmed' });
    });
    const seedMs = performance.now() - start;
    const file = join(root, '.converge', 'T1.sqlite');
    const dataBytes = statSync(file).size;
    expect(dataBytes).toBeGreaterThan(5 * 1024 * 1024);
    const inspector = new DatabaseSync(file, { readOnly: true });
    try {
      expect(inspector.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
      const key = timeKey(at);
      const plans: Array<[string, SQLInputValue[], string, RegExp]> = [
        [SQL.children[1], ['root', idKey('n261'), 12], 'nodes_children', /parent_id=\?.*id_key>\?/],
        [SQL.refsFrom[1], ['root', idKey('f450'), 12], 'refs_from', /from_id=\?.*id_key>\?/],
        [SQL.refsTo[1], ['n1', idKey('f450'), 12], 'refs_to', /to_node_id=\?.*id_key>\?/],
        [SQL.revisions[1], [key, idKey('r2300'), 12], 'revisions_time', /\(time_key,id_key\)<\(\?,\?\)/],
        [SQL.nodeHistory[1], ['root', key, idKey('r2300'), 12], 'revision_nodes_time', /node_id=\?.*\(time_key,id_key\)</],
        [SQL.pendingFormations[1], ['ai', key, idKey('r2300'), 12], 'pending_formations_seek', /by=\?.*\(time_key,id_key\)</],
        [SQL.pendingImports[1], [idKey('s0'), 12], 'nodes_pending_imports', /id_key>\?/],
        [SQL.pendingMembers, ['r1'], 'nodes_pending_members', /change_id=\?/],
        [SQL.confirmation, ['seed', 'seed1'], 'revisions_confirmed', /confirmed_kind=\?.*confirmed_id=\?/],
      ];
      for (const [sql, args, index, bounds] of plans) {
        const detail = inspector.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => String(row.detail)).join('\n');
        expect(detail, detail).toContain(index);
        expect(detail, detail).toMatch(bounds);
        expect(detail, detail).not.toMatch(/SCAN |USE TEMP B-TREE/);
      }
    } finally { inspector.close(); }
    const held = await storage.openRead('T1');
    try {
      const wal = `${file}-wal`;
      const before = existsSync(wal) ? statSync(wal).size : 0;
      const timings: number[] = [];
      const writes = 25;
      for (let i = 1; i <= writes; i += 1) {
        const mark = performance.now();
        await storage.transact('T1', 'existing', async (tx) => {
          const id = `n${i}`;
          const previous = await tx.readNode(id);
          if (previous === null) throw new Error('规模夹具缺节点');
          tx.writeNode({ ...previous, state: 'open', confirmation: 'unconfirmed', currentChange: { revisionId: `new${i}`, by: 'ai' } });
          tx.appendRevision(formation(`new${i}`, 'ai', [id]));
        });
        const current = await storage.openRead('T1');
        try {
          const [children, refs, history, pending] = await Promise.all([
            current.listChildren('root', 'n2150', 12), current.listRefsTo('n1', 'f410', 12),
            current.listRevisions('root', 'r2400', 12), current.listUnconfirmed(['ai'], { revisionId: 'r2300' }, 12),
          ]);
          expect([children.length, refs.length, history.length, pending.length]).toEqual([12, 12, 12, 12]);
          expect(children[0]).not.toHaveProperty('body');
        } finally { await current.close(); }
        timings.push(performance.now() - mark);
      }
      const growth = statSync(wal).size - before;
      expect(growth).toBeGreaterThan(0);
      expect(growth).toBeLessThan(dataBytes);
      expect(held.stamp).toBe(1);
      expect(await held.readRevision('new1')).toBeNull();
      timings.sort((a, b) => a - b);
      console.info(`SQLite 隔离规模：${dataBytes} B，${size} 个普通节点，${fanout} 条入边，${writes} 笔小写+四个 12 项 seek；` +
        `自举 ${seedMs.toFixed(1)} ms，延迟 min/p50/max=${timings[0].toFixed(1)}/${timings[Math.floor(writes / 2)].toFixed(1)}/${timings[writes - 1].toFixed(1)} ms，WAL 增量 ${growth} B`);
    } finally { await held.close(); }
  }, 20_000);
});
