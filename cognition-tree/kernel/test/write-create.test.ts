/** 通过正式操作目录验证新建、读取与确认；用内存端口回放提交增量，不接触宿主业务数据。 */
import { expect, it, vi } from 'vitest';
import { createKernel } from '../src/catalog';
import type { OpInput } from '../src/catalog/contracts';
import { MemoryTreeStore } from '../src/storage/memory';
import type { BeforeCommit } from '../src/storage/memory';

const INSTANT = '2026-11-20T19:50:09+08:00';
const request = { treeId: 'new-tree', rootQuestion: '  从哪里开始？\n' };
const root = { treeId: request.treeId, nodeId: request.treeId };

/**
 * 装配独立的新建测试环境与可观测时钟。
 * @param beforeCommit 可选的保存回调，用于观测实际写集或注入故障
 * @returns 正式操作目录、空存储与固定时钟
 */
function setup(beforeCommit?: BeforeCommit) {
  const store = new MemoryTreeStore({ beforeCommit });
  const clock = { now: vi.fn(() => INSTANT) };
  return { kernel: createKernel({ store, clock }), store, clock };
}

it.each(['human', 'ai'] as const)('%s 新建的唯一根与未确认形成记录同笔提交，重开仍可读', async (actor) => {
  const persist = vi.fn<BeforeCommit>();
  const { kernel, clock } = setup(persist);
  expect(await kernel.dispatch(actor, 'createTree', request)).toBe(request.treeId);
  expect(clock.now).toHaveBeenCalledTimes(1);

  const saved = await kernel.dispatch('human', 'readNode', root);
  const history = saved.currentChange!;
  expect(saved.node).toStrictEqual({
    id: request.treeId, parentId: null, body: { title: request.rootQuestion }, origin: { kind: 'branch' },
    state: 'open', confirmation: 'unconfirmed', currentChange: { revisionId: history.id, by: actor },
  });
  expect(history).toStrictEqual({
    id: expect.any(String), at: INSTANT, kind: 'formation', by: actor, nodeIds: [request.treeId],
    summary: expect.any(String), detail: { action: 'createTree', effects: [{ nodeId: request.treeId, afterState: 'open' }] },
  });
  expect(persist).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledWith(request.treeId, 'createNew', { nodes: [saved.node], refs: [], revisions: [history] });

  // 模拟重开：用同一份已保存的增量恢复另一份存储，不经过自举或重造形成记录。
  const [treeId, mode, delta] = persist.mock.calls[0];
  const store = new MemoryTreeStore();
  await store.transact(treeId, mode, (tx) => {
    for (const node of delta.nodes) tx.writeNode(node);
    for (const ref of delta.refs) tx.writeRef(ref);
    for (const revision of delta.revisions) tx.appendRevision(revision);
  });
  const reopened = createKernel({ store, clock });
  expect(await reopened.dispatch('ai', 'readNode', root)).toEqual(saved);
  expect((await reopened.dispatch('ai', 'readHistory', { ...root, limit: 10 })).items).toStrictEqual([history]);
  expect((await reopened.dispatch('human', 'readUnconfirmed', { treeId, by: [actor], limit: 10 })).items).toEqual([
    { revisionId: history.id, at: INSTANT, by: actor, nodeIds: [root.nodeId], summary: history.summary },
  ]);
  expect((await reopened.dispatch('human', 'readUnconfirmed', { treeId, by: ['import'], limit: 10 })).items).toEqual([]);
  const snapshot = await store.openRead(treeId);
  try {
    expect(snapshot.rootId).toBe(root.nodeId);
    expect(snapshot.stamp).toBe(1);
  } finally {
    await snapshot.close();
  }
});

it('拒绝缺失、空白或非法参数以及夹带的身份、种子和历史，不发起提交', async () => {
  const persist = vi.fn<BeforeCommit>();
  const { kernel, store, clock } = setup(persist);
  const invalid: unknown[] = [
    null, [request], { treeId: request.treeId }, { rootQuestion: request.rootQuestion },
    { ...request, treeId: ' \t' }, { ...request, rootQuestion: '\r\n　\t' },
    { ...request, rootQuestion: 42 }, { ...request, rootQuestion: { title: '不是字符串' } },
    Object.create({ rootQuestion: request.rootQuestion }, { treeId: { value: request.treeId, enumerable: true } }),
  ];
  const injections = {
    seed: {}, history: [], actor: 'human', by: 'human', confirmation: 'humanConfirmed',
    currentChange: { by: 'human', revisionId: 'forged' }, state: 'keep',
    rootId: 'forged', parentId: 'forged', refs: [], nodes: [],
  };
  for (const [key, value] of Object.entries(injections)) invalid.push({ ...request, [key]: value });
  for (const input of invalid) {
    await expect(kernel.dispatch('ai', 'createTree', input as OpInput['createTree'])).rejects.toMatchObject({ code: 'invalid' });
  }
  // @ts-expect-error import 是记录来源，不是可信调用身份。
  await expect(kernel.dispatch('import', 'createTree', request)).rejects.toMatchObject({ code: 'invalid' });
  expect(clock.now).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  await expect(store.openRead(request.treeId)).rejects.toMatchObject({ code: 'missing' });
});

it('同名并发只有先到事务提交，随后重试也不会覆盖根或追加记录', async () => {
  const persist = vi.fn<BeforeCommit>();
  const { kernel, clock } = setup(persist);
  const duplicate = { ...request, rootQuestion: '不应覆盖原来的问题' };
  const results = await Promise.allSettled([
    kernel.dispatch('human', 'createTree', request),
    kernel.dispatch('ai', 'createTree', duplicate),
  ]);
  expect(results).toMatchObject([
    { status: 'fulfilled', value: request.treeId }, { status: 'rejected', reason: { code: 'invalid' } },
  ]);
  await expect(kernel.dispatch('human', 'createTree', duplicate)).rejects.toMatchObject({ code: 'invalid' });
  expect(clock.now).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledTimes(1);
  const saved = await kernel.dispatch('ai', 'readNode', root);
  expect(saved.node.body).toEqual({ title: request.rootQuestion });
  expect(saved.currentChange?.by).toBe('human');
  expect((await kernel.dispatch('ai', 'readHistory', { treeId: request.treeId, limit: 10 })).items).toEqual([saved.currentChange]);
});

it('AI 新建后只能由人单独确认形成记录，不能当作导入根确认或重复确认', async () => {
  const { kernel } = setup();
  const treeId = await kernel.dispatch('ai', 'createTree', request);
  const saved = await kernel.dispatch('human', 'readNode', root);
  const target = { revisionId: saved.currentChange!.id };
  const forged = { treeId, target, actor: 'human' };
  await expect(kernel.dispatch('ai', 'confirm', forged)).rejects.toMatchObject({ code: 'invalid' });
  await expect(kernel.dispatch('human', 'confirm', { treeId, target: { seedNodeId: root.nodeId } }))
    .rejects.toMatchObject({ code: 'invalid' });
  expect(await kernel.dispatch('human', 'readNode', root)).toEqual(saved);

  const confirmation = await kernel.dispatch('human', 'confirm', { treeId, target });
  await expect(kernel.dispatch('human', 'confirm', { treeId, target })).rejects.toMatchObject({ code: 'invalid' });
  expect(await kernel.dispatch('human', 'readNode', root)).toEqual({
    ...saved, node: { ...saved.node, confirmation: 'humanConfirmed' },
  });
  expect((await kernel.dispatch('ai', 'readHistory', { treeId, limit: 10 })).items).toEqual([
    { id: confirmation, kind: 'confirmation', by: 'human', at: INSTANT, nodeIds: [root.nodeId],
      summary: expect.any(String), detail: { target } },
    saved.currentChange,
  ]);
  expect((await kernel.dispatch('human', 'readUnconfirmed', { treeId, by: ['ai'], limit: 10 })).items).toEqual([]);
});

it('提交故障使新树及其形成记录都不可见，之后可用同一 ID 干净重试', async () => {
  let fail = true;
  let beforePublishError: unknown;
  const persist = vi.fn<BeforeCommit>(async (treeId) => {
    if (!fail) return;
    try {
      const snapshot = await store.openRead(treeId);
      await snapshot.close();
    } catch (error) {
      beforePublishError = error;
    }
    throw new Error('测试：保存阶段失败');
  });
  const { kernel, store } = setup(persist);
  await expect(kernel.dispatch('ai', 'createTree', request)).rejects.toMatchObject({ code: 'storage' });
  expect(beforePublishError).toMatchObject({ code: 'missing' });
  expect(persist).toHaveBeenCalledTimes(1);
  await expect(store.openRead(request.treeId)).rejects.toMatchObject({ code: 'missing' });

  fail = false;
  const treeId = await kernel.dispatch('human', 'createTree', { ...request, rootQuestion: '成功重试的新问题？' });
  const saved = await kernel.dispatch('ai', 'readNode', root);
  expect(saved.node.body.title).toBe('成功重试的新问题？');
  expect((await kernel.dispatch('ai', 'readHistory', { treeId, limit: 10 })).items).toMatchObject([
    { by: 'human', detail: { action: 'createTree' } },
  ]);
});
