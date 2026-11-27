/** 隔离 SQLite 归档测试；走真实事务、默认查询和内核命令，不接 DSH profile。 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernel } from '@cognition-tree/kernel/catalog';
import type { CognitionNode, FormationRevision, Revision, WriteTransaction } from '@cognition-tree/kernel/types';
import { SqliteTreeStore } from '../src/server/storage';
import { idKey } from '../src/server/storage/order-keys';
import { APPLICATION_ID, LEGACY_SCHEMA, LEGACY_SCHEMA_VERSION, SCHEMA_VERSION } from '../src/server/storage/schema';

const local = fileURLToPath(new URL('../../../../.local-work/', import.meta.url));
const stores = new Set<SqliteTreeStore>();
const at = '2026-11-26T12:00:00Z';
const treeId = 'T1';

/**
 * 创建或重开一个隔离工作区的 SQLite 存储。
 * @param root 可选先前工作区；缺省分配独占目录
 */
function fixture(root?: string) {
  mkdirSync(local, { recursive: true });
  const workspace = root ?? mkdtempSync(join(local, 'archive-store-'));
  const changes: Array<{ treeId: string; stamp: number; revisions: Revision[]; visibilityChanged?: true }> = [];
  const store = new SqliteTreeStore(workspace, (event) => { changes.push(event); });
  stores.add(store);
  return { store, changes, workspace, file: join(workspace, '.converge', `${treeId}.sqlite`) };
}

/**
 * 构造节点夹具；不使用 ID 字符串推断父链。
 * @param id 稳定节点 ID
 * @param parentId 真实父节点或 null（树根）
 */
function node(id: string, parentId: string | null): CognitionNode {
  return { id, parentId, body: { title: `标题 ${id}`, text: `正文 ${id}` }, origin: { kind: 'branch' } };
}

/**
 * 构造同一时间戳下可由自然序区分的形成事件。
 * @param id 修订 ID
 * @param by 执行者种类
 * @param nodes 形成效果端点
 */
function formation(id: string, by: 'human' | 'ai', ...nodes: string[]): FormationRevision {
  return { id, at, kind: 'formation', by, nodeIds: nodes, summary: id, detail: {
    action: 'addBranch', effects: nodes.map((nodeId) => ({ nodeId, afterState: 'keep' })),
  } };
}

/** 测试仅关闭自已的句柄，保留隔离 SQLite 文件。 */
afterEach(async () => {
  try { await Promise.all([...stores].map((store) => store.close())); }
  finally { stores.clear(); }
});

describe('SQLite 归档与恢复', () => {
  it('保留嵌套显式归档、原有正文和稳定 ID；整树归档不再出现在日常目录', async () => {
    const { store, changes, workspace, file } = fixture();
    await store.transact(treeId, 'createNew', (tx) => {
      for (const n of [node('root', null), node('branch', 'root'), node('nested', 'branch'), node('leaf', 'nested')]) {
        tx.writeNode(n);
      }
    });
    const fresh = new DatabaseSync(file, { readOnly: true });
    try { expect(fresh.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION }); }
    finally { fresh.close(); }
    const before = await store.openRead(treeId);
    await store.setArchived(treeId, 'branch', true);
    await store.setArchived(treeId, 'nested', true); // 已因祖先隐藏，仍可独立标记。
    await store.setArchived(treeId, 'branch', true); // 幂等，无 stamp 或通知变化。
    await expect(store.listArchived(treeId)).resolves.toEqual([
      { treeId, nodeId: 'branch', title: '标题 branch' },
      { treeId, nodeId: 'nested', title: '标题 nested' },
    ]);
    const during = await store.openRead(treeId);
    expect(during.stamp).toBe(3);
    expect(await during.readNode('leaf')).toBeNull();
    expect(await before.readNode('leaf')).toEqual(node('leaf', 'nested'));

    await store.setArchived(treeId, undefined, true);
    await expect(store.listArchived()).resolves.toEqual([{ treeId, title: '标题 root' }]);
    await expect(store.listArchived(treeId)).rejects.toMatchObject({ code: 'missing' });
    await expect(store.listTrees()).resolves.toEqual({ trees: [], unavailable: [] });
    await expect(store.openRead(treeId)).rejects.toMatchObject({ code: 'missing' });
    const work = vi.fn();
    await expect(store.transact(treeId, 'existing', work)).rejects.toMatchObject({ code: 'missing' });
    await expect(store.transact(treeId, 'createNew', work)).rejects.toMatchObject({ code: 'invalid' });
    expect(work).not.toHaveBeenCalled();
    expect(changes).toEqual([
      { treeId, stamp: 1, revisions: [] },
      ...[2, 3, 4].map((stamp) => ({ treeId, stamp, revisions: [], visibilityChanged: true })),
    ]);
    await store.close();

    const { store: reopened, changes: restored } = fixture(workspace);
    await expect(reopened.listArchived()).resolves.toEqual([{ treeId, title: '标题 root' }]);
    await reopened.setArchived(treeId, 'root', false);
    await expect(reopened.listArchived()).resolves.toEqual([]);
    await reopened.setArchived(treeId, 'branch', false);
    const midway = await reopened.openRead(treeId);
    expect(await midway.readNode('branch')).toEqual(node('branch', 'root'));
    expect(await midway.readNode('nested')).toBeNull();
    expect(await midway.readNode('leaf')).toBeNull();
    await expect(reopened.listArchived(treeId)).resolves.toEqual([{ treeId, nodeId: 'nested', title: '标题 nested' }]);
    await reopened.setArchived(treeId, 'nested', false);
    await reopened.setArchived(treeId, 'nested', false);
    expect(await (await reopened.openRead(treeId)).readNode('leaf')).toEqual(node('leaf', 'nested'));
    expect(restored).toEqual([5, 6, 7].map((stamp) => ({ treeId, stamp, revisions: [], visibilityChanged: true })));

    await reopened.setArchived(treeId, 'nested', true);
    await reopened.setArchived(treeId, 'branch', true);
    await reopened.setArchived(treeId, 'nested', false); // 取消自己的标记，但不可见状态未变。
    await expect(reopened.listArchived(treeId)).resolves.toEqual([{ treeId, nodeId: 'branch', title: '标题 branch' }]);
    expect(await (await reopened.openRead(treeId)).readNodeRow('leaf')).toBeNull();
    await reopened.setArchived(treeId, 'branch', false);
    expect(await (await reopened.openRead(treeId)).readNode('leaf')).toEqual(node('leaf', 'nested'));
  });

  it('在子节点、双向引用的首尾分页前排除隐藏端点，恢复后同一批边重新可见', async () => {
    const { store } = fixture();
    await store.transact(treeId, 'createNew', (tx) => {
      for (const n of [node('root', null), node('n1', 'root'), node('hiddenLeaf', 'n1'),
        node('n2', 'root'), node('n3', 'root'), node('n4', 'root')]) tx.writeNode(n);
      const edges = [
        ['f1', 'root', 'hiddenLeaf'], ['f2', 'root', 'n2'], ['f3', 'root', 'n1'],
        ['f5', 'hiddenLeaf', 'n2'], ['f6', 'n3', 'n2'], ['f7', 'n1', 'n2'], ['f8', 'n4', 'n2'],
      ];
      for (const [id, from, to] of edges) tx.writeRef({ id, from, kind: 'example', target: { nodeId: to } });
      tx.writeRef({ id: 'f4', from: 'root', kind: 'example', target: { doc: '来源.md' } });
      tx.writeRef({ id: 'f9', from: 'hiddenLeaf', kind: 'example', target: { doc: '另一来源.md' } });
    });
    await store.setArchived(treeId, 'n1', true);
    await store.setArchived(treeId, 'n3', true);
    const s = await store.openRead(treeId);
    expect(await s.readNode('hiddenLeaf')).toBeNull();
    expect(await s.readNodeRow('n1')).toBeNull();
    expect(await s.listChildren('n1', null, 8)).toEqual([]);
    expect((await s.listChildren('root', null, 1)).map(({ id }) => id)).toEqual(['n2']);
    expect((await s.listChildren('root', 'n2', 1)).map(({ id }) => id)).toEqual(['n4']);
    expect((await s.listRefsFrom('root', null, 1)).map(({ id }) => id)).toEqual(['f2']);
    expect(await s.listRefsFrom('root', 'f2', 1)).toEqual([
      { id: 'f4', from: 'root', kind: 'example', target: { doc: '来源.md' } },
    ]);
    expect(await s.listRefsFrom('hiddenLeaf', null, 8)).toEqual([]);
    expect(await s.listRefsTo('hiddenLeaf', null, 8)).toEqual([]);
    expect((await s.listRefsTo('n2', null, 1)).map(({ id }) => id)).toEqual(['f2']);
    expect((await s.listRefsTo('n2', 'f2', 1)).map(({ id }) => id)).toEqual(['f8']);
    await store.setArchived(treeId, 'n1', false);
    const restored = await store.openRead(treeId);
    expect((await restored.listRefsFrom('root', null, 10)).map(({ id }) => id)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect((await restored.listRefsTo('n2', null, 10)).map(({ id }) => id)).toEqual(['f2', 'f5', 'f7', 'f8']);
    expect((await restored.listRefsFrom('hiddenLeaf', null, 10)).map(({ id }) => id)).toEqual(['f5', 'f9']);
  });

  it('先过滤时间线和待确认页；混合修订、结构化目标和当前形成不泄露隐藏端点', async () => {
    const { store } = fixture();
    const mixed: FormationRevision = {
      ...formation('r8', 'ai', 'candidate', 'old'), summary: '以 candidate 接替 old', detail: {
        action: 'applyReplacement', effects: [{ nodeId: 'candidate', afterState: 'keep' }, { nodeId: 'old', afterState: 'prune' }],
        replacement: { oldId: 'old', newId: 'candidate' }, reason: '更完整', reviveWhen: '有反例',
      },
    };
    await store.transact(treeId, 'createNew', (tx) => {
      tx.writeNode(node('root', null));
      tx.writeNode({ ...node('old', 'root'), state: 'prune', confirmation: 'unconfirmed', currentChange: { revisionId: 'r8', by: 'ai' } });
      tx.writeNode({ ...node('candidate', 'root'), state: 'keep', origin: { kind: 'replacement', status: 'applied', replacesId: 'old' },
        confirmation: 'unconfirmed', currentChange: { revisionId: 'r8', by: 'ai' } });
      tx.writeNode({ ...node('proposed', 'root'), state: 'open', origin: { kind: 'replacement', status: 'proposed', replacesId: 'old' } });
      tx.writeNode({ ...node('seed1', 'old'), confirmation: 'unconfirmed' });
      tx.writeNode({ ...node('seed3', 'old'), confirmation: 'unconfirmed' });
      tx.writeNode({ ...node('seed2', 'root'), confirmation: 'unconfirmed' });
      tx.writeNode({ ...node('seed4', 'root'), confirmation: 'unconfirmed' });
      tx.writeNode({ ...node('activeAi', 'root'), confirmation: 'unconfirmed', currentChange: { revisionId: 'r3', by: 'ai' } });
      tx.writeNode({ ...node('activeHuman', 'root'), confirmation: 'unconfirmed', currentChange: { revisionId: 'r2', by: 'human' } });
      tx.writeNode({ ...node('hiddenAi', 'old'), confirmation: 'unconfirmed', currentChange: { revisionId: 'r9', by: 'ai' } });
      tx.appendRevision(formation('r1', 'ai', 'candidate'));
      tx.appendRevision(formation('r2', 'human', 'activeHuman'));
      tx.appendRevision(formation('r3', 'ai', 'activeAi'));
      tx.appendRevision({ ...formation('r4', 'ai', 'candidate'), kind: 'confirmation', by: 'import', detail: { target: { seedNodeId: 'seed1' } } });
      tx.appendRevision({ ...formation('r5', 'ai', 'seed1'), nodeIds: ['candidate'], by: 'import' });
      tx.appendRevision({ ...mixed, id: 'r6', nodeIds: ['candidate'], by: 'import', detail: { ...mixed.detail, effects: [] } });
      tx.appendRevision({ ...formation('r7', 'ai', 'candidate'), kind: 'confirmation', by: 'import', detail: { target: { revisionId: 'r8' } } });
      tx.appendRevision(mixed);
      tx.appendRevision(formation('r9', 'ai', 'hiddenAi'));
      // 史料可能将另一条确认登记为确认目标；不能沿两跳漏出隐藏修订 ID。
      tx.appendRevision({ ...formation('r10', 'ai', 'candidate'), kind: 'confirmation', by: 'import', detail: { target: { revisionId: 'r7' } } });
    });
    await store.setArchived(treeId, 'old', true);
    const s = await store.openRead(treeId);
    expect((await s.listRevisions(null, null, 1)).map(({ id }) => id)).toEqual(['r3']);
    expect((await s.listRevisions(null, 'r3', 2)).map(({ id }) => id)).toEqual(['r2', 'r1']);
    expect((await s.listRevisions('candidate', null, 1)).map(({ id }) => id)).toEqual(['r1']);
    expect(await s.listRevisions('old', null, 5)).toEqual([]);
    await expect(s.listRevisions(null, 'r8', 1)).rejects.toMatchObject({ code: 'invalid' });
    for (const id of ['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']) expect(await s.readRevision(id)).toBeNull();

    const first = await s.listUnconfirmed(['human', 'ai', 'import'], null, 1);
    expect(first).toEqual([{ revisionId: 'r3', at, by: 'ai', summary: 'r3', nodeIds: ['activeAi'] }]);
    expect(await s.listUnconfirmed(['human', 'ai', 'import'], { revisionId: 'r3' }, 2)).toEqual([
      { revisionId: 'r2', at, by: 'human', summary: 'r2', nodeIds: ['activeHuman'] },
      { seedNodeId: 'seed2', title: '标题 seed2' },
    ]);
    expect(await s.listUnconfirmed(['import'], { seedNodeId: 'seed2' }, 1)).toEqual([{ seedNodeId: 'seed4', title: '标题 seed4' }]);
    const row = await s.readNodeRow('candidate');
    expect(row).toMatchObject({ id: 'candidate', origin: { kind: 'branch' }, confirmation: 'unconfirmed' });
    expect(row).not.toHaveProperty('currentChange');
    expect((await s.listChildren('root', null, 20)).find(({ id }) => id === 'candidate')).toEqual(row);

    const kernel = createKernel({ store, clock: { now: () => at } });
    const details = await kernel.dispatch('human', 'readNode', { treeId, nodeId: 'candidate' });
    expect(details).toEqual({
      node: { ...node('candidate', 'root'), state: 'keep', confirmation: 'unconfirmed' },
      confirmationUnavailable: true,
    });
    expect(await kernel.dispatch('human', 'readNode', { treeId, nodeId: 'seed2' })).not.toHaveProperty('confirmationUnavailable');
    await expect(kernel.dispatch('human', 'confirm', { treeId, target: { seedNodeId: 'candidate' } }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(kernel.dispatch('human', 'confirm', { treeId, target: { revisionId: 'r8' } }))
      .rejects.toMatchObject({ code: 'missing' });
    await expect(kernel.dispatch('ai', 'decideNode', {
      treeId, nodeId: 'proposed', decision: { type: 'setOpenOrKeep', state: 'keep', reason: '测试' },
    })).rejects.toMatchObject({ code: 'invalid' });
    await store.setArchived(treeId, 'old', false);
    expect(await kernel.dispatch('human', 'readNode', { treeId, nodeId: 'candidate' })).toMatchObject({
      node: { origin: { kind: 'replacement', status: 'applied', replacesId: 'old' }, currentChange: { revisionId: 'r8', by: 'ai' } },
      currentChange: mixed,
    });
    expect(await (await store.openRead(treeId)).listUnconfirmed(['ai'], { revisionId: 'r9' }, 1))
      .toEqual([{ revisionId: 'r8', at, by: 'ai', summary: mixed.summary, nodeIds: ['candidate', 'old'] }]);
  });

  it('归档与日常写串行；常规端口也不能写隐藏节点、引用、来历或修订明细', async () => {
    const { store, changes } = fixture();
    await store.transact(treeId, 'createNew', (tx) => {
      tx.writeNode(node('root', null));
      tx.writeNode(node('branch', 'root'));
      tx.writeNode(node('leaf', 'branch'));
    });
    const archive = store.setArchived(treeId, 'branch', true);
    const write = store.transact(treeId, 'existing', async (tx) => {
      expect(await tx.readNode('leaf')).toBeNull();
      tx.writeNode(node('anotherLeaf', 'leaf'));
    });
    await expect(write).rejects.toMatchObject({ code: 'missing' });
    await archive;
    const rejected: Array<(tx: WriteTransaction) => void> = [
      (tx) => tx.writeNode({ ...node('leaf', 'branch'), state: 'open' }),
      (tx) => tx.writeNode({ ...node('replacement', 'root'), origin: { kind: 'replacement', status: 'proposed', replacesId: 'branch' } }),
      (tx) => tx.writeRef({ id: 'f1', from: 'leaf', kind: 'example', target: { doc: '材料.md' } }),
      (tx) => tx.writeRef({ id: 'f1', from: 'root', kind: 'example', target: { nodeId: 'leaf' } }),
      (tx) => tx.appendRevision(formation('r1', 'ai', 'leaf')),
      (tx) => tx.appendRevision({ ...formation('r1', 'ai', 'leaf'), nodeIds: ['root'] }),
    ];
    for (const attempt of rejected) {
      await expect(store.transact(treeId, 'existing', (tx) => {
        tx.writeNode(node('rolledBack', 'root'));
        try { attempt(tx); } catch { /* 即使 work 捕获，事务也不能提交。 */ }
      })).rejects.toMatchObject({ code: 'missing' });
    }
    const s = await store.openRead(treeId);
    expect(await s.readNode('rolledBack')).toBeNull();
    expect(s.stamp).toBe(2);
    expect(changes.map(({ stamp }) => stamp)).toEqual([1, 2]);
    await store.setArchived(treeId, 'branch', false);
    expect(await (await store.openRead(treeId)).readNode('leaf')).toEqual(node('leaf', 'branch'));
  });

  it('v1 日常读写不迁移；归档升级原子提交，版本护栏始终读取事务中的实际版本', async () => {
    const { store, file, workspace, changes } = fixture();
    mkdirSync(join(workspace, '.converge'));
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${LEGACY_SCHEMA_VERSION};`);
      db.exec(LEGACY_SCHEMA.join(';\n'));
      db.exec('BEGIN');
      for (const item of [node('root', null), node('legacy', 'root')]) {
        db.prepare(`INSERT INTO nodes (id, id_key, parent_id, title, origin) VALUES (?, ?, ?, ?, ?)`)
          .run(item.id, idKey(item.id), item.parentId, item.body.title, JSON.stringify(item.origin));
        db.prepare('INSERT INTO node_bodies (node_id, body) VALUES (?, ?)').run(item.id, JSON.stringify(item.body));
      }
      db.prepare('INSERT INTO tree_meta (singleton, tree_id, root_id, stamp) VALUES (1, ?, ?, 20)').run(treeId, 'root');
      db.exec('COMMIT; PRAGMA journal_mode = WAL');
    } finally { db.close(); }
    const original = readFileSync(file);
    const first = await store.openRead(treeId);
    expect(first.stamp).toBe(20);
    expect(await first.readNode('legacy')).toEqual(node('legacy', 'root'));
    await expect(store.listArchived()).resolves.toEqual([]);
    await expect(store.listArchived(treeId)).resolves.toEqual([]);
    expect(readFileSync(file)).toEqual(original);
    const stale = { code: 'invalid', message: /重新读取.*重新判断/ };
    const staleWork = vi.fn();
    await expect(store.transactAtStamp(treeId, first.stamp - 1, staleWork)).rejects.toMatchObject(stale);
    expect(staleWork).not.toHaveBeenCalled();
    await store.setArchived(treeId, 'legacy', false);
    await expect(store.setArchived(treeId, 'missing', true)).rejects.toMatchObject({ code: 'missing' });
    const abort = new Error('测试写失败');
    await expect(store.transactAtStamp(treeId, first.stamp, (tx) => {
      tx.writeNode(node('rolled-back', 'root'));
      throw abort;
    })).rejects.toBe(abort);
    function expectLegacy(stamp: number) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: LEGACY_SCHEMA_VERSION });
        expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'node_archive'").get()).toBeUndefined();
        expect(db.prepare("SELECT id FROM nodes WHERE id = 'rolled-back'").get()).toBeUndefined();
        expect(db.prepare('SELECT stamp FROM tree_meta').get()).toMatchObject({ stamp });
      } finally { db.close(); }
    }
    expectLegacy(20);
    expect(changes).toEqual([]);

    const daily = store.transactAtStamp(treeId, first.stamp, (tx) => tx.writeNode(node('daily', 'root')));
    const queuedV1 = store.transactAtStamp(treeId, first.stamp, staleWork);
    await Promise.all([daily, expect(queuedV1).rejects.toMatchObject(stale)]);
    expectLegacy(21);
    expect(changes).toEqual([{ treeId, stamp: 21, revisions: [] }]);

    // v2 与新 stamp 仍在 WAL 中；排在归档后的写入不能使用旧头或入队时的版本。
    const archive = store.setArchived(treeId, 'legacy', true);
    const queuedV2 = store.transactAtStamp(treeId, 21, staleWork);
    await Promise.all([archive, expect(queuedV2).rejects.toMatchObject(stale)]);
    expect(readFileSync(file).readUInt32BE(60)).toBe(LEGACY_SCHEMA_VERSION);
    expect(staleWork).not.toHaveBeenCalled();
    expect(changes).toEqual([
      { treeId, stamp: 21, revisions: [] },
      { treeId, stamp: 22, revisions: [], visibilityChanged: true },
    ]);
    const latest = await store.openRead(treeId);
    expect(latest.stamp).toBe(22);
    expect(await latest.readNode('legacy')).toBeNull();
    expect(await latest.readNode('daily')).toEqual(node('daily', 'root'));
    expect(await first.readNode('legacy')).toEqual(node('legacy', 'root'));
    expect(await first.readNode('daily')).toBeNull();
    await store.close();

    const inspector = new DatabaseSync(file, { readOnly: true });
    try {
      expect(inspector.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION });
      expect(inspector.prepare('SELECT * FROM node_archive').all()).toEqual([{ node_id: 'legacy', explicit: 1 }]);
      expect(inspector.prepare("SELECT id FROM nodes WHERE id = 'legacy'").get()).toMatchObject({ id: 'legacy' });
    } finally { inspector.close(); }
    const { store: reopened } = fixture(workspace);
    await reopened.setArchived(treeId, 'legacy', false);
    expect(await (await reopened.openRead(treeId)).readNode('legacy')).toEqual(node('legacy', 'root'));
  });
});
