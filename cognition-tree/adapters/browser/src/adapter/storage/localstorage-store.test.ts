/**
 * localStorage TreeStore 适配器的用例：重开、成功才发布、写失败回滚、损坏与版本护栏。
 *
 * 用内存版 Storage 替身模拟浏览器 localStorage；每次重开用同一份存储建新实例，
 * 对应刷新页面后从持久化历史重放。
 */
import { describe, expect, it } from 'vitest';
import {
  CognitionError,
  type CognitionNode,
  type FormationRevision,
  type ReadSnapshot,
} from '@cognition-tree/kernel/types';
import { MemoryStorage } from './memory-storage.test-util';
import { LocalStorageTreeStore } from './localstorage-store';
import { TreeJournal } from './journal';

/** 造根节点。 */
function root(): CognitionNode {
  return { id: 'T1', parentId: null, body: { title: '根问题' }, state: 'open', confirmation: 'unconfirmed', origin: { kind: 'branch' } };
}

/** 造普通子节点。 */
function child(id: string): CognitionNode {
  return { id, parentId: 'T1', body: { title: id }, state: 'open', confirmation: 'unconfirmed', origin: { kind: 'branch' } };
}

/** 造一条新写形成记录（新增分支）。 */
function addRevision(id: string, nodeId: string): FormationRevision {
  return {
    id,
    kind: 'formation',
    at: '2026-11-20T20:00:00+08:00',
    by: 'human',
    nodeIds: [nodeId],
    summary: '新增 ' + nodeId,
    detail: { action: 'addBranch', effects: [{ nodeId, afterState: 'open' }] },
  };
}

/** 在空存储上建一棵只有根的树。 */
async function bootstrap(store: LocalStorageTreeStore): Promise<void> {
  await store.transact('T1', 'createNew', (tx) => {
    tx.writeNode(root());
    tx.appendRevision(addRevision('r1', 'T1'));
  });
}

/** 一并读根与孩子的快照。 */
async function readAll(store: LocalStorageTreeStore): Promise<{ snap: ReadSnapshot; root: CognitionNode | null; child: CognitionNode | null }> {
  const snap = await store.openRead('T1');
  return { snap, root: await snap.readNode('T1'), child: await snap.readNode('T1.1') };
}

describe('LocalStorageTreeStore', () => {
  it('提交后重开（新实例）仍能读回节点、修订与版本', async () => {
    const storage = new MemoryStorage();
    const first = new LocalStorageTreeStore({ storage });
    await bootstrap(first);
    await first.transact('T1', 'existing', (tx) => {
      tx.writeNode(child('T1.1'));
      tx.appendRevision(addRevision('r2', 'T1.1'));
    });
    expect(first.committedStamp('T1')).toBe(2);

    const reopened = new LocalStorageTreeStore({ storage });
    const { snap, root: r, child: c } = await readAll(reopened);
    expect(snap.stamp).toBe(2);
    expect(snap.rootId).toBe('T1');
    expect(r?.body.title).toBe('根问题');
    expect(c?.body.title).toBe('T1.1');
    expect((await snap.listRevisions(null, null, 10)).map((x) => x.id)).toEqual(['r2', 'r1']);
  });

  it('重放历史不再写存储；日常提交只新增一个 delta 并更新 head', async () => {
    const storage = new MemoryStorage();
    const first = new LocalStorageTreeStore({ storage });
    await bootstrap(first);
    const reopened = new LocalStorageTreeStore({ storage });
    storage.resetWrites();
    await readAll(reopened);
    expect(storage.writes).toEqual([]);

    await reopened.transact('T1', 'existing', (tx) => tx.writeNode(child('T1.1')));
    expect(storage.writes.map((w) => w.key.split(':').slice(-2).join(':'))).toEqual(['delta:2', 'T1:head']);
  });

  it('提交成功后才取到本次通知，且带提交后版本与新增修订', async () => {
    const storage = new MemoryStorage();
    const store = new LocalStorageTreeStore({ storage });
    expect(store.takeCommit('T1')).toBeUndefined();
    await bootstrap(store);
    const commit = store.takeCommit('T1');
    expect(commit?.stamp).toBe(1);
    expect(commit?.revisions.map((r) => r.id)).toEqual(['r1']);
    expect(store.takeCommit('T1')).toBeUndefined();
  });

  it('注入保存失败：事务报 storage，内存与持久化都不变', async () => {
    const storage = new MemoryStorage();
    const store = new LocalStorageTreeStore({ storage });
    await bootstrap(store);
    expect(store.takeCommit('T1')?.stamp).toBe(1);
    store.armNextCommitFailure();
    expect(store.failureArmed()).toBe(true);

    await expect(
      store.transact('T1', 'existing', (tx) => {
        tx.writeNode(child('T1.1'));
        tx.appendRevision(addRevision('r2', 'T1.1'));
      }),
    ).rejects.toMatchObject({ code: 'storage' });

    expect(store.failureArmed()).toBe(false);
    const { snap, child: c } = await readAll(store);
    expect(snap.stamp).toBe(1);
    expect(c).toBeNull();
    expect(store.committedStamp('T1')).toBe(1);
    expect(store.takeCommit('T1')).toBeUndefined();
    // 重新打开也不会看到失败的那次写入。
    const reopened = new LocalStorageTreeStore({ storage });
    expect((await readAll(reopened)).snap.stamp).toBe(1);
    expect((await readAll(reopened)).child).toBeNull();
  });

  it('写 head 失败时回滚内存并清掉刚落下的 delta，下一次仍可正常提交', async () => {
    const storage = new MemoryStorage();
    const store = new LocalStorageTreeStore({ storage });
    await bootstrap(store);
    storage.failNextWrite((key) => key.endsWith(':head'));

    await expect(
      store.transact('T1', 'existing', (tx) => tx.writeNode(child('T1.1'))),
    ).rejects.toMatchObject({ code: 'storage' });
    expect(store.committedStamp('T1')).toBe(1);
    expect((await readAll(store)).child).toBeNull();

    await store.transact('T1', 'existing', (tx) => tx.writeNode(child('T1.1')));
    expect(store.committedStamp('T1')).toBe(2);
    expect((await readAll(store)).child?.id).toBe('T1.1');
  });

  it('head 或 delta 损坏时报 storage，不当作空树也不覆盖', async () => {
    const prefix = 'converge.cognition-tree.test.v2:tree:T1:';
    for (const seed of [
      { [prefix + 'head']: '{oops' },
      { [prefix + 'head']: '{"version":1,"treeId":"T1","commits":1}', [prefix + 'delta:1']: '{"version":1}' },
    ]) {
      const store = new LocalStorageTreeStore({ storage: new MemoryStorage(seed) });
      await expect(store.openRead('T1')).rejects.toMatchObject({ code: 'storage' });
      await expect(store.openRead('T1')).rejects.toMatchObject({ code: 'storage' });
      expect(store.committedStamp('T1')).toBeNull();
    }
  });

  it('页面外写入改变 head 时拒绝拼接：本次不提交，内存停在旧版本', async () => {
    const storage = new MemoryStorage();
    const store = new LocalStorageTreeStore({ storage });
    await bootstrap(store);

    // 模拟另一个标签页在同一个 localStorage 上又提交了一笔。
    const outside = new TreeJournal(storage);
    outside.append('T1', 'existing', {
      nodes: [child('T9')],
      refs: [],
      revisions: [addRevision('r9', 'T9')],
    });

    await expect(
      store.transact('T1', 'existing', (tx) => tx.writeNode(child('T1.1'))),
    ).rejects.toMatchObject({ code: 'storage' });
    // 存储 head 已是页面外的 v2，本页内存仍是 v1；冲突已报出来，没有拼接。
    expect(store.committedStamp('T1')).toBe(2);
    expect((await readAll(store)).snap.stamp).toBe(1);
    expect((await readAll(store)).child).toBeNull();
    // 页面外那笔历史没有被改写成我们的。
    expect(outside.delta('T1', 2).revisions.map((r) => r.id)).toEqual(['r9']);
  });

  it('不存在的树读 missing；createNew 成功后才有版本', async () => {
    const store = new LocalStorageTreeStore({ storage: new MemoryStorage() });
    await expect(store.openRead('T1')).rejects.toMatchObject({ code: 'missing' });
    expect(store.committedStamp('T1')).toBeNull();
    expect(store.storageBytes('T1')).toBe(0);
    await bootstrap(store);
    expect(store.committedStamp('T1')).toBe(1);
    expect(store.storageBytes('T1')).toBeGreaterThan(0);
    expect((await readAll(store)).root?.id).toBe('T1');
  });

  it('清空只移除本树测试数据，并让新实例从空状态开始', async () => {
    const storage = new MemoryStorage({ 'converge.cognition-tree.proto.v1:T1': '{"legacy":true}' });
    const store = new LocalStorageTreeStore({ storage });
    await bootstrap(store);
    store.clear('T1');
    expect(store.committedStamp('T1')).toBeNull();
    expect(storage.getItem('converge.cognition-tree.proto.v1:T1')).toBe('{"legacy":true}');
    // 开发坞清空后立即重载页面；新实例从空存储开始，旧实例内存里的东西不再可续用。
    const reopened = new LocalStorageTreeStore({ storage });
    await expect(reopened.openRead('T1')).rejects.toBeInstanceOf(CognitionError);
  });
});
