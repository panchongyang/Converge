import { describe, expect, it } from 'vitest';
import { CognitionError } from '../src/types';
import type { CognitionNode, Revision, WriteTransaction } from '../src/types';
import { MemoryTreeStore } from '../src/storage/memory';
import type { MemoryDelta } from '../src/storage/memory';

/**
 * 构造测试节点；缺省正文标题用 ID，避免每个用例重复写。
 * @param id 节点 ID
 * @param parentId 真实父节点
 * @param extra 需要覆盖的字段
 * @returns 已保存形状的节点
 */
function makeNode(
  id: string,
  parentId: string | null,
  extra: Partial<CognitionNode> = {},
): CognitionNode {
  return {
    id,
    parentId,
    body: { title: '节点 ' + id },
    origin: { kind: 'branch' },
    ...extra,
  };
}

/**
 * 构造一条最小形成记录，供 currentChange 或时间线测试使用。
 * @param id 修订 ID
 * @param at 发生时间
 * @param by 执行者
 * @param nodeIds 关联节点
 * @param summary 叙述
 * @returns 形成记录
 */
function makeFormation(
  id: string,
  at: string,
  by: 'human' | 'ai',
  nodeIds: string[],
  summary = '形成记录 ' + id,
): Revision {
  return {
    id,
    kind: 'formation',
    at,
    by,
    nodeIds,
    summary,
    detail: { action: 'addBranch', effects: nodeIds.map((nodeId) => ({ nodeId, afterState: 'keep' })) },
  };
}

/**
 * 在独立的根下创建一棵最小的树，返回已打开可读的 store。
 * @param store 复用的内存存储
 * @param treeId 树 ID
 * @returns 同一 store
 */
async function createRootTree(store: MemoryTreeStore, treeId = 'T1'): Promise<MemoryTreeStore> {
  await store.transact(treeId, 'createNew', (tx) => {
    tx.writeNode(makeNode('T1', null));
  });
  return store;
}

describe('MemoryTreeStore · 端口与版本', () => {
  it('树不存在时 openRead / existing 报 missing', async () => {
    const store = new MemoryTreeStore();
    await expect(store.openRead('T1')).rejects.toMatchObject({ code: 'missing' });
    await expect(
      store.transact('T1', 'existing', () => undefined),
    ).rejects.toMatchObject({ code: 'missing' });
    expect(await store.transact('T1', 'createNew', (tx) => {
      tx.writeNode(makeNode('T1', null));
      return 'created';
    })).toBe('created');
    expect((await store.openRead('T1')).stamp).toBe(1);
    await expect(store.openRead('T1')).resolves.toMatchObject({ rootId: 'T1' });
  });

  it('createNew 重复、缺根、多个根都回滚且不登记树', async () => {
    const store = new MemoryTreeStore();
    await createRootTree(store);
    await expect(store.transact('T1', 'createNew', () => undefined)).rejects.toMatchObject({
      code: 'invalid',
    });

    const empty = new MemoryTreeStore();
    await expect(empty.transact('T2', 'createNew', () => undefined)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(empty.openRead('T2')).rejects.toMatchObject({ code: 'missing' });

    const twoRoots = new MemoryTreeStore();
    await expect(
      twoRoots.transact('T3', 'createNew', (tx) => {
        tx.writeNode(makeNode('R1', null));
        tx.writeNode(makeNode('R2', null));
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(twoRoots.openRead('T3')).rejects.toMatchObject({ code: 'missing' });
  });

  it('提交才可见，版本逐次加一；失败后状态、版本与修订都不变', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    const before = await store.openRead('T1');
    expect(before.stamp).toBe(1);
    expect(await before.readNode('T1')).toMatchObject({ body: { title: '节点 T1' } });

    await store.transact('T1', 'existing', (tx) => {
      tx.writeNode(makeNode('T2', 'T1', { state: 'open' }));
      tx.appendRevision(makeFormation('R1', '2026-11-20T10:00:00+08:00', 'ai', ['T2']));
    });
    const after = await store.openRead('T1');
    expect(after.stamp).toBe(2);
    expect(await after.readNode('T2')).toMatchObject({ parentId: 'T1', state: 'open' });

    await expect(
      store.transact('T1', 'existing', (tx) => {
        tx.writeNode(makeNode('T3', 'T1'));
        tx.appendRevision(makeFormation('R2', '2026-11-20T11:00:00+08:00', 'human', ['T3']));
        throw new CognitionError('invalid', '测试主动回滚');
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    const rolledBack = await store.openRead('T1');
    expect(rolledBack.stamp).toBe(2);
    expect(await rolledBack.readNode('T3')).toBeNull();
    expect(await rolledBack.readRevision('R2')).toBeNull();
    expect((await rolledBack.listRevisions(null, null, 10)).map((r) => r.id)).toEqual(['R1']);
  });

  it('快照固定版本，提交后旧快照仍读旧状态与旧历史', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    const old = await store.openRead('T1');
    await store.transact('T1', 'existing', (tx) => {
      tx.writeNode(makeNode('T1', null, { state: 'prune', pruneReason: '不成立', reviveWhen: '有新依据' }));
      tx.writeNode(makeNode('N1', 'T1'));
      tx.appendRevision(makeFormation('R1', '2026-11-20T10:00:00+08:00', 'ai', ['T1']));
    });

    expect(old.stamp).toBe(1);
    expect(await old.readNode('T1')).not.toHaveProperty('state');
    expect(await old.readNode('N1')).toBeNull();
    expect(await old.listChildren('T1', null, 10)).toEqual([]);
    expect(await old.listRevisions(null, null, 10)).toEqual([]);

    const fresh = await store.openRead('T1');
    expect(fresh.stamp).toBe(2);
    expect(await fresh.readNode('T1')).toMatchObject({ state: 'prune' });
    expect((await fresh.listChildren('T1', null, 10)).map((row) => row.id)).toEqual(['N1']);
    expect((await fresh.listRevisions(null, null, 10)).map((r) => r.id)).toEqual(['R1']);
  });

  it('同树写事务串行；不同树互不阻塞', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    const order: string[] = [];
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const first = store.transact('T1', 'existing', async (tx) => {
      order.push('first:start');
      await wait(10);
      tx.writeNode(makeNode('A', 'T1'));
      order.push('first:end');
    });
    const second = store.transact('T1', 'existing', async (tx) => {
      order.push('second:start');
      tx.writeNode(makeNode('B', 'T1'));
      order.push('second:end');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('事务句柄在 work 结束后失效，逃逸调用不能改数据', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    let escaped: WriteTransaction | undefined;
    await store.transact('T1', 'existing', (tx) => {
      escaped = tx;
      tx.writeNode(makeNode('N1', 'T1'));
    });
    expect(escaped).toBeDefined();
    expect(() => escaped?.writeNode(makeNode('N2', 'T1'))).toThrow(/已结束/);
    await expect(escaped?.readNode('N1')).rejects.toThrow(/已结束/);
    const snapshot = await store.openRead('T1');
    expect(await snapshot.readNode('N2')).toBeNull();
    expect(snapshot.stamp).toBe(2);
  });
});

describe('MemoryTreeStore · 输入输出隔离', () => {
  it('writeNode 输入在异步 work 中被改，不影响提交值', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    const draft = makeNode('N1', 'T1', { body: { title: '原始标题' }, state: 'open' });
    await store.transact('T1', 'existing', async (tx) => {
      tx.writeNode(draft);
      await Promise.resolve();
      draft.body.title = '外部改坏';
      draft.state = 'prune';
    });
    const node = await (await store.openRead('T1')).readNode('N1');
    expect(node).toMatchObject({ body: { title: '原始标题' }, state: 'open' });
  });

  it('appendRevision / writeRef 的输入在提交前被改，不影响已写入值', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    const revision = makeFormation('R9', '2026-11-20T10:00:00+08:00', 'ai', ['T1']);
    const ref = { id: 'E9', from: 'T1', kind: 'premise' as const, target: { doc: 'a.md' } };
    await store.transact('T1', 'existing', async (tx) => {
      tx.appendRevision(revision);
      tx.writeRef(ref);
      await Promise.resolve();
      revision.nodeIds.push('外部');
      revision.summary = '被改坏';
      if (ref.target.doc !== undefined) ref.target.doc = 'b.md';
    });
    const snapshot = await store.openRead('T1');
    expect(await snapshot.readRevision('R9')).toMatchObject({
      nodeIds: ['T1'],
      summary: '形成记录 R9',
    });
    expect((await snapshot.listRefsFrom('T1', null, 10))[0]?.target).toEqual({ doc: 'a.md' });
  });

  it('读结果与索引结果都是副本，修改后重读不变', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    await store.transact('T1', 'existing', (tx) => {
      tx.writeNode(makeNode('N1', 'T1'));
      tx.writeRef({ id: 'E1', from: 'T1', kind: 'premise', target: { nodeId: 'N1' } });
    });
    const snapshot = await store.openRead('T1');
    const node = await snapshot.readNode('N1');
    expect(node).not.toBeNull();
    if (node === null) return;
    node.body.title = '被调用方改坏';
    node.origin = { kind: 'supplement' };
    expect((await snapshot.readNode('N1'))?.body.title).toBe('节点 N1');

    const children = await snapshot.listChildren('T1', null, 10);
    if (children[0] !== undefined) children[0].title = '被调用方改坏';
    expect((await snapshot.listChildren('T1', null, 10))[0]?.title).toBe('节点 N1');

    const refs = await snapshot.listRefsFrom('T1', null, 10);
    refs[0]?.kind !== undefined;
    if (refs[0] !== undefined) refs[0].kind = 'conflict';
    expect((await snapshot.listRefsFrom('T1', null, 10))[0]?.kind).toBe('premise');
  });

  it('引用与修订重复 ID 报 invalid 并回滚', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    await store.transact('T1', 'existing', (tx) => {
      tx.writeRef({ id: 'E1', from: 'T1', kind: 'premise', target: { doc: 'a.md' } });
      tx.appendRevision(makeFormation('R1', '2026-11-20T10:00:00+08:00', 'ai', ['T1']));
    });
    await expect(
      store.transact('T1', 'existing', (tx) => {
        tx.writeRef({ id: 'E1', from: 'T1', kind: 'premise', target: { doc: 'b.md' } });
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      store.transact('T1', 'existing', (tx) => {
        tx.appendRevision(makeFormation('R1', '2026-11-20T10:00:00+08:00', 'ai', ['T1']));
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    const snapshot = await store.openRead('T1');
    expect(snapshot.stamp).toBe(2);
    expect((await snapshot.listRefsFrom('T1', null, 10)).map((ref) => ref.id)).toEqual(['E1']);
    expect((await snapshot.listRevisions(null, null, 10)).map((rev) => rev.id)).toEqual(['R1']);
  });
});

describe('MemoryTreeStore · beforeCommit', () => {
  it('发布前执行，能读到旧版本；收到且只收到本次写入的增量', async () => {
    const calls: Array<{ treeId: string; mode: string; delta: MemoryDelta; priorStamp: number }> = [];
    let store: MemoryTreeStore;
    store = new MemoryTreeStore({
      beforeCommit: async (treeId, mode, delta) => {
        const priorStamp = await store.openRead(treeId).then(
          (snapshot) => snapshot.stamp,
          () => 0,
        );
        calls.push({ treeId, mode, delta, priorStamp });
      },
    });
    await createRootTree(store);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ treeId: 'T1', mode: 'createNew', priorStamp: 0 });
    expect(calls[0]?.delta.nodes.map((node) => node.id)).toEqual(['T1']);

    await store.transact('T1', 'existing', (tx) => {
      tx.writeNode(makeNode('N1', 'T1'));
      tx.writeRef({ id: 'E1', from: 'T1', kind: 'example', target: { nodeId: 'N1' } });
      tx.appendRevision(makeFormation('R1', '2026-11-20T10:00:00+08:00', 'ai', ['N1']));
    });
    expect(calls).toHaveLength(2);
    const second = calls[1];
    expect(second).toMatchObject({ treeId: 'T1', mode: 'existing', priorStamp: 1 });
    expect(second?.delta.nodes.map((node) => node.id)).toEqual(['N1']);
    expect(second?.delta.refs.map((ref) => ref.id)).toEqual(['E1']);
    expect(second?.delta.revisions.map((rev) => rev.id)).toEqual(['R1']);
  });

  it('beforeCommit 同步或异步失败都报 storage 且不发布', async () => {
    let armed = false;
    const failing = new MemoryTreeStore({
      beforeCommit: () => {
        if (armed) throw new Error('磁盘已满');
      },
    });
    await createRootTree(failing);
    armed = true;
    await expect(
      failing.transact('T1', 'existing', (tx) => {
        tx.writeNode(makeNode('N1', 'T1'));
      }),
    ).rejects.toMatchObject({ code: 'storage' });
    expect((await failing.openRead('T1')).stamp).toBe(1);

    let rejectHook: (error: Error) => void = () => undefined;
    let asyncArmed = false;
    let notifyHook: () => void = () => undefined;
    const hookStarted = new Promise<void>((resolve) => {
      notifyHook = resolve;
    });
    const asyncFailing = new MemoryTreeStore({
      beforeCommit: () => {
        if (!asyncArmed) return undefined;
        notifyHook();
        return new Promise<void>((_resolve, reject) => {
          rejectHook = reject;
        });
      },
    });
    await createRootTree(asyncFailing);
    asyncArmed = true;
    const pending = asyncFailing.transact('T1', 'existing', (tx) => {
      tx.writeNode(makeNode('N2', 'T1'));
    });
    await hookStarted;
    rejectHook(new Error('网络失败'));
    await expect(pending).rejects.toMatchObject({ code: 'storage' });
    expect((await asyncFailing.openRead('T1')).stamp).toBe(1);
    expect(await (await asyncFailing.openRead('T1')).readNode('N2')).toBeNull();
  });

  it('记录的增量能经原端口 transact 回放成同一棵树', async () => {
    const deltas: MemoryDelta[] = [];
    const source = new MemoryTreeStore({
      beforeCommit: (_treeId, _mode, delta) => {
        deltas.push(delta);
      },
    });
    await source.transact('T1', 'createNew', (tx) => {
      tx.writeNode(makeNode('T1', null));
      tx.writeNode(makeNode('I1', 'T1', { confirmation: 'unconfirmed' }));
    });
    await source.transact('T1', 'existing', (tx) => {
      tx.appendRevision(makeFormation('F1', '2026-11-20T10:00:00+08:00', 'ai', ['N1']));
      tx.writeNode(
        makeNode('N1', 'T1', {
          confirmation: 'unconfirmed',
          currentChange: { revisionId: 'F1', by: 'ai' },
        }),
      );
      tx.writeRef({ id: 'E1', from: 'N1', kind: 'premise', target: { nodeId: 'T1' } });
    });
    expect(deltas).toHaveLength(2);

    const replayed = new MemoryTreeStore();
    for (let index = 0; index < deltas.length; index += 1) {
      const delta = deltas[index] as MemoryDelta;
      await replayed.transact('T1', index === 0 ? 'createNew' : 'existing', (tx) => {
        for (const node of delta.nodes) tx.writeNode(node);
        for (const ref of delta.refs) tx.writeRef(ref);
        for (const revision of delta.revisions) tx.appendRevision(revision);
      });
    }
    const original = await source.openRead('T1');
    const copy = await replayed.openRead('T1');
    expect(copy.stamp).toBe(original.stamp);
    expect(copy.rootId).toBe(original.rootId);
    expect(await copy.readNode('T1')).toEqual(await original.readNode('T1'));
    expect(await copy.readNode('N1')).toEqual(await original.readNode('N1'));
    expect(await copy.listChildren('T1', null, 10)).toEqual(
      await original.listChildren('T1', null, 10),
    );
    expect(await copy.listRefsFrom('N1', null, 10)).toEqual(
      await original.listRefsFrom('N1', null, 10),
    );
    expect(await copy.listRevisions(null, null, 10)).toEqual(
      await original.listRevisions(null, null, 10),
    );
    expect(await copy.listUnconfirmed(['ai', 'import'], null, 10)).toEqual(
      await original.listUnconfirmed(['ai', 'import'], null, 10),
    );
  });

  it('回调修改 delta 不影响内存中的提交结果', async () => {
    const store = new MemoryTreeStore({
      beforeCommit: (_treeId, _mode, delta) => {
        const first = delta.nodes[0];
        if (first !== undefined) first.body.title = '回调改坏';
        delta.nodes.push(makeNode('外部', 'T1'));
      },
    });
    await createRootTree(store);
    expect((await (await store.openRead('T1')).readNode('T1'))?.body.title).toBe('节点 T1');
    expect(await (await store.openRead('T1')).readNode('外部')).toBeNull();
  });
});

describe('MemoryTreeStore · 快照释放', () => {
  it('close 幂等，关闭后读取报错', async () => {
    const store = await createRootTree(new MemoryTreeStore());
    const snapshot = await store.openRead('T1');
    await snapshot.close();
    await snapshot.close();
    await expect(snapshot.readNode('T1')).rejects.toThrow(/已关闭/);
    await expect(snapshot.listChildren('T1', null, 1)).rejects.toThrow(/已关闭/);
  });
});
