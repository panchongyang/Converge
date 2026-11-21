/** §3.4 自举模型联测：使用代表性 T1 种子；不把手稿翻译或正式导入视为本测试的能力。 */
import { expect, it } from 'vitest';
import { createWriteModel } from '../src/models';
import { MemoryTreeStore } from '../src/storage/memory';
import type { BeforeCommit } from '../src/storage/memory';
import type { Draft, NodeId, ReadSnapshot, SeedNode, SeedTree } from '../src/types';

const DAY = '2026-11-19';
const FIVE = ['T1.2.2', 'T1.2.3', 'T1.2.5', 'T1.3.3.1', 'T1.3.3.2'];
const PENDING = 'T1.2.4';
const NO_STATE = 'T1.3';
const PRUNED = 'T1.3.1';

/**
 * 构造一条可覆盖已译字段的种子节点。
 * @param id 手稿稳定节点 ID
 * @param parentId 手稿中的父 ID，根为 null
 * @param fields 保留的可选正文、状态、来历或确认字段
 * @returns 尚未写入的种子节点
 */
function node(id: NodeId, parentId: NodeId | null, fields: Partial<SeedNode> = {}): SeedNode {
  return { id, parentId, origin: { kind: 'branch' }, body: { title: `判断 ${id}` }, ...fields };
}

/**
 * 构造包含手稿缺项及 #8 范围的代表性种子；生产手稿解析不在本模型中。
 * @returns 每次重新构造的独立测试种子
 */
function seedTree(): SeedTree {
  const confirmed = { state: 'keep', confirmation: 'humanConfirmed' } as const;
  return {
    treeId: 'seed-tree', rootId: 'T1',
    nodes: [
      node('T1', null), node('T1.2', 'T1'), node(NO_STATE, 'T1'), node('T1.3.3', NO_STATE),
      node('T1.2.2', 'T1.2', confirmed), node('T1.2.3', 'T1.2', confirmed), node('T1.2.5', 'T1.2', confirmed),
      node('T1.3.3.1', 'T1.3.3', confirmed), node('T1.3.3.2', 'T1.3.3', confirmed),
      node(PENDING, 'T1.2', { state: 'open', confirmation: 'unconfirmed' }),
      node(PRUNED, NO_STATE, { state: 'prune', body: { title: '纯树', basis: '手稿中的依据' },
        confirmation: 'humanConfirmed', pruneReason: '理由已知，复活条件未载' }),
    ],
    refs: [
      { id: 'handwritten-ref', from: 'T1.2.2', kind: 'premise', target: { nodeId: PRUNED, part: 'pruneReason' } },
      { id: 'source-ref', from: PRUNED, kind: 'example', target: { doc: 'research/example.md', part: 'E02' } },
    ],
    history: [
      { kind: 'formation', at: DAY, by: 'import', nodeIds: ['T1'], summary: '手稿开篇', source: '认知树.md #1' },
      { kind: 'confirmation', at: DAY, by: 'import', nodeIds: [...FIVE], summary: '确认五项，不含未决概念层',
        source: '认知树.md #8' },
    ],
  };
}

/**
 * 建立一个尚无树的正式内存端口及写模型。
 * @param beforeCommit 可选发布前保存回调，用于故障注入
 * @returns 未自举的测试对象与可计数时钟
 */
function setup(beforeCommit?: BeforeCommit) {
  let clockReads = 0;
  const store = new MemoryTreeStore({ beforeCommit });
  const model = createWriteModel(store, {
    /** 返回固定的带时区时刻，测试要求自举阶段不调用此端口。 */
    now() {
      clockReads += 1;
      return '2026-11-20T12:00:00Z';
    },
  });
  return { store, model, clockReads: () => clockReads };
}

/**
 * 在被测树的一个已提交快照上检查多个事实并释放快照。
 * @param store 被观察的内存存储端口
 * @param treeId 被观察的目标树
 * @param check 同一个快照上的检查
 */
async function inspect(store: MemoryTreeStore, treeId: string, check: (snapshot: ReadSnapshot) => Promise<void>) {
  const snapshot = await store.openRead(treeId);
  try {
    await check(snapshot);
  } finally {
    await snapshot.close();
  }
}

it('自举一次保留节点/引用 ID、手稿缺项、时间精度和历史范围，不新增确认或取时间', async () => {
  const { model, store, clockReads } = setup();
  const seed = seedTree();
  const id = await model.bootstrapTree(seed);
  expect(id).toBe(seed.treeId);
  expect(clockReads()).toBe(0);
  await inspect(store, id, async (snapshot) => {
    expect(snapshot.rootId).toBe(seed.rootId);
    expect(snapshot.stamp).toBe(1);
    for (const original of seed.nodes) {
      const saved = await snapshot.readNode(original.id);
      expect(saved).toEqual(original);
      expect(saved).not.toHaveProperty('currentChange');
    }
    const pruned = await snapshot.readNode(PRUNED);
    expect(pruned).not.toHaveProperty('reviveWhen');
    expect(await snapshot.readNode(NO_STATE)).not.toHaveProperty('state');
    expect(await snapshot.readNode(NO_STATE)).not.toHaveProperty('confirmation');
    expect(await snapshot.listRefsTo(PRUNED, null, 10)).toEqual([seed.refs[0]]);
    expect(await snapshot.listRefsFrom(PRUNED, null, 10)).toEqual([seed.refs[1]]);
    const history = await snapshot.listRevisions(null, null, 10);
    expect(history.map(({ id: _, ...entry }) => entry)).toEqual([...seed.history].reverse());
    expect(new Set(history.map((entry) => entry.id)).size).toBe(2);
    expect(history[0].nodeIds).toEqual(FIVE);
    expect(history[0].nodeIds).not.toContain(PENDING);
    expect(history.every((entry) => entry.at === DAY && entry.by === 'import')).toBe(true);
    expect(await snapshot.listUnconfirmed(['import'], null, 10)).toEqual([{ seedNodeId: PENDING, title: `判断 ${PENDING}` }]);
  });
  seed.nodes[0].body.title = '尝试覆盖原树';
  await expect(model.bootstrapTree(seed)).rejects.toMatchObject({ code: 'invalid' });
  await inspect(store, id, async (snapshot) => {
    expect(snapshot.stamp).toBe(1);
    expect((await snapshot.readNode(seed.rootId))?.body.title).not.toBe('尝试覆盖原树');
    expect(await snapshot.listRevisions(null, null, 10)).toHaveLength(2);
  });
  expect(clockReads()).toBe(0);
});

it.each([PENDING, NO_STATE])('可以明确确认无日常变更的导入判断 %s，状态、指针和原历史不变', async (nodeId) => {
  const { model, store, clockReads } = setup();
  const seed = seedTree();
  const id = await model.bootstrapTree(seed);
  const target = { seedNodeId: nodeId };
  const confirmed = await model.confirm(id, target);
  await expect(model.confirm(id, target)).rejects.toMatchObject({ code: 'invalid' });
  await inspect(store, id, async (snapshot) => {
    const original = seed.nodes.find((entry) => entry.id === nodeId);
    expect(await snapshot.readNode(nodeId)).toEqual({ ...original, confirmation: 'humanConfirmed' });
    expect(await snapshot.readRevision(confirmed)).toMatchObject({
      kind: 'confirmation', by: 'human', nodeIds: [nodeId], detail: { target },
    });
    const history = await snapshot.listRevisions(null, null, 10);
    expect(history.map(({ id: _, ...entry }) => entry).slice(1)).toEqual([...seed.history].reverse());
    const pending = await snapshot.listUnconfirmed(['import'], null, 10);
    expect(pending.map((entry) => entry.seedNodeId)).toEqual(nodeId === PENDING ? [] : [PENDING]);
    expect(snapshot.stamp).toBe(2);
  });
  expect(clockReads()).toBe(1);
});

it('拒绝多根、重复 ID、悬空端点、非连通父链和伪造的原历史/当前指针', async () => {
  const { model, store, clockReads } = setup();
  const seed = seedTree();
  const bad: (SeedTree | object)[] = [
    { ...seed, rootId: '不存在的根' },
    { ...seed, nodes: [...seed.nodes, node('多出的根', null)] },
    { ...seed, nodes: [...seed.nodes, node('T1', null)] },
    { ...seed, nodes: [...seed.nodes, node('坏父节点', '不存在的父节点')] },
    { ...seed, nodes: [...seed.nodes, node('环甲', '环乙'), node('环乙', '环甲')] },
    { ...seed, nodes: [...seed.nodes, node('浮空替代', 'T1',
      { origin: { kind: 'replacement', replacesId: PRUNED, status: 'proposed' } })] },
    { ...seed, nodes: [...seed.nodes, { ...node('伪造指针', 'T1'), currentChange: { revisionId: '历史', by: 'human' } }] },
    { ...seed, refs: [...seed.refs, seed.refs[0]] },
    { ...seed, refs: [{ id: '坏引用', from: '不存在的起点', kind: 'example', target: { nodeId: PRUNED } }] },
    { ...seed, refs: [{ id: '坏引用', from: PRUNED, kind: 'example', target: { nodeId: '不存在的目标' } }] },
    { ...seed, refs: [{ id: '非法前提', from: PRUNED, kind: 'premise', target: { nodeId: NO_STATE } }] },
    { ...seed, history: [{ ...seed.history[0], nodeIds: ['不存在的关联'] }] },
    { ...seed, history: [{ ...seed.history[0], by: 'human' }] },
    { ...seed, history: [{ ...seed.history[0], detail: { target: { seedNodeId: 'T1' } } }] },
    { ...seed, history: [{ ...seed.history[0], detail: {
      action: 'createTree', effects: [{ nodeId: 'T1', afterState: 'open' }],
    } }] },
  ];
  for (const one of bad) {
    await expect(model.bootstrapTree(one as SeedTree)).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.openRead(seed.treeId)).rejects.toMatchObject({ code: 'missing' });
  }
  expect(clockReads()).toBe(0);
});

it('自举、新增和出向引用的发布失败均不可见；撤销故障可重试', async () => {
  let fail = true;
  let attemptedNode: NodeId | undefined;
  const { model, store, clockReads } = setup((_treeId, mode, delta) => {
    if (mode === 'existing') attemptedNode = delta.nodes[0]?.id;
    if (fail) throw new Error('测试：存储发布失败');
  });
  const seed = seedTree();
  const { treeId } = seed;
  await expect(model.bootstrapTree(seed)).rejects.toMatchObject({ code: 'storage' });
  await expect(store.openRead(treeId)).rejects.toMatchObject({ code: 'missing' });
  expect(clockReads()).toBe(0);
  fail = false;
  expect(await model.bootstrapTree(seed)).toBe(treeId);
  const placement = { parentId: seed.rootId, kind: 'branch' } as const;
  const draft: Draft = { body: { title: '事务失败的写入' }, state: 'keep',
    refs: [{ kind: 'example', target: { nodeId: 'T1.2' } }] };
  fail = true;
  await expect(model.addBranch('ai', treeId, placement, draft)).rejects.toMatchObject({ code: 'storage' });
  expect(attemptedNode).toBeDefined();
  await inspect(store, treeId, async (snapshot) => {
    expect(snapshot.stamp).toBe(1);
    expect(await snapshot.readNode(attemptedNode!)).toBeNull();
    expect(await snapshot.listRefsTo('T1.2', null, 10)).toEqual([]);
    expect(await snapshot.listRevisions(null, null, 10)).toHaveLength(seed.history.length);
  });
  fail = false;
  const saved = await model.addBranch('ai', treeId, placement, draft);
  expect(saved).toBe(attemptedNode);
  await inspect(store, treeId, async (snapshot) => {
    expect(snapshot.stamp).toBe(2);
    expect(await snapshot.readNode(saved)).toMatchObject({ body: draft.body, confirmation: 'unconfirmed' });
    expect(await snapshot.listRefsTo('T1.2', null, 10)).toMatchObject([{ from: saved }]);
  });
});
