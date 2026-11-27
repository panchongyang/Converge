/** §3.1 正式内存端口联测：日常决定、形成与确认绑定、历史不可变及单树提交回滚。 */
import { expect, it, vi } from 'vitest';
import { createKernel } from '../src/catalog';
import { createWriteModel } from '../src/models';
import { MemoryTreeStore } from '../src/storage/memory';
import type { BeforeCommit } from '../src/storage/memory';
import type {
  CognitionNode, ConfirmTarget, DailyActor, Decision, Draft, FormationRevision, NodeId, Placement, ReadSnapshot,
  SeedTree, TreeStore,
} from '../src/types';

const NOW = '2026-11-20T20:30:00.123+08:00';
const ROOT = 'root';
const OLD = 'old';
const SIBLING = 'sibling';
const LEGACY = 'legacy';
const UNKNOWN = 'unknown';
const REPLACEMENT = { type: 'applyReplacement', reason: '新判断证据更强', reviveWhen: '新证据被推翻' } as const;
const PRUNE = { type: 'prune', reason: '剪除理由', reviveWhen: '复活条件' } as const;

/**
 * 建立内存树并提供可计数的固定时钟，初始样本含手稿缺项、已有确认和原引用。
 * @param beforeCommit 可选的发布前故障注入或观察回调
 * @returns 已完成自举的正式模型、内存端口和时钟计数器
 */
async function setup(beforeCommit?: BeforeCommit) {
  const seed: SeedTree = {
    treeId: 'write-case', rootId: ROOT,
    nodes: [
      { id: ROOT, parentId: null, body: { title: '根问题' }, origin: { kind: 'branch' } },
      { id: OLD, parentId: ROOT, body: { title: '原判断', text: '保存后不改', basis: '原证据' },
        origin: { kind: 'branch' }, state: 'keep', confirmation: 'humanConfirmed' },
      { id: SIBLING, parentId: ROOT, body: { title: '待确认判断' },
        origin: { kind: 'branch' }, state: 'open', confirmation: 'unconfirmed' },
      { id: LEGACY, parentId: OLD, body: { title: '手稿剪枝' },
        origin: { kind: 'branch' }, state: 'prune', pruneReason: '原手稿理由' },
      { id: UNKNOWN, parentId: ROOT, body: { title: '状态与确认均未载', note: '保留原说明' }, origin: { kind: 'branch' } },
    ],
    refs: [{ id: 'ref-old', from: OLD, kind: 'example', target: { nodeId: SIBLING, part: '原局部' } }],
    history: [{ kind: 'confirmation', by: 'import', at: '2026-11-19', nodeIds: [OLD],
      summary: '手稿原确认', source: '手稿 #1' }],
  };
  const store = new MemoryTreeStore({ beforeCommit });
  let calls = 0;
  const clock = {
    /** 为每条新记录返回固定的实时时刻，并记录调用次数。 */
    now() {
      calls += 1;
      return NOW;
    },
  };
  const model = createWriteModel(store, clock);
  const treeId = await model.bootstrapTree(seed);
  expect(calls).toBe(0);
  return { model, treeId, seed, store, clock, clockCalls: () => calls };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * 从正式只读快照观察一次已提交的数据，并确保释放快照。
 * @param setupResult 被观察的树和端口
 * @param inspect 在同一快照上的检查
 * @returns 检查结果
 */
async function read<T>({ store, treeId }: Setup, inspect: (snapshot: ReadSnapshot) => Promise<T>): Promise<T> {
  const snapshot = await store.openRead(treeId);
  try {
    return await inspect(snapshot);
  } finally {
    await snapshot.close();
  }
}

/**
 * 从同一快照观察当前节点及它指向的形成记录，测试不自行重现写规则。
 * @param setupResult 被观察的树
 * @param id 要定位的节点 ID
 * @returns 已保存节点与其形成记录
 */
async function formation(setupResult: Setup, id: NodeId): Promise<{ node: CognitionNode; revision: FormationRevision }> {
  return read(setupResult, async (snapshot) => {
    const node = await snapshot.readNode(id);
    if (node?.currentChange === undefined) throw new Error(`测试节点 ${id} 无当前变更`);
    const revision = await snapshot.readRevision(node.currentChange.revisionId);
    if (revision?.kind !== 'formation' || revision.by === 'import') throw new Error(`节点 ${id} 未指向日常形成记录`);
    return { node, revision };
  });
}

/**
 * 取用例所需的稳定数据，用于断言拒绝/回滚没有更改节点、引用、历史、索引或版本。
 * @param setupResult 被观察的树
 * @param nodes 需逐个对比的节点 ID，缺省只看原节点
 * @returns 由同一快照取得的已提交事实
 */
async function state(setupResult: Setup, nodes: NodeId[] = [OLD, SIBLING, LEGACY, UNKNOWN]) {
  return read(setupResult, async (snapshot) => ({
    stamp: snapshot.stamp,
    nodes: await Promise.all(nodes.map((id) => snapshot.readNode(id))),
    children: await snapshot.listChildren(ROOT, null, 100),
    refs: await snapshot.listRefsFrom(OLD, null, 100),
    history: await snapshot.listRevisions(null, null, 100),
    pending: await snapshot.listUnconfirmed(['human', 'ai', 'import'], null, 100),
  }));
}

const OPEN: Draft = { body: { title: '新判断', text: '待保存正文' }, state: 'open', refs: [] };

it('用当前视图版本新增与决定；同版本排队的过期写入不记形成、不通知', async () => {
  const beforeCommit = vi.fn();
  const sut = await setup(beforeCommit);
  const { treeId } = sut;
  const kernel = createKernel(sut);
  const view = () => kernel.dispatch('ai', 'readView', {
    treeId, focus: { root: true },
    expand: { subtreeDepth: 'leaf', jumpHops: 0, direction: 'out', jumpFrom: 'anchor', afterJumpDepth: 0 },
    budget: { maxScans: 100, maxNodes: 20, maxBytes: 8000 }, onLimit: 'exact',
  });
  const add = { treeId, placement: { parentId: ROOT, kind: 'branch' } as const, draft: OPEN };
  const decide = { treeId, nodeId: OLD, decision: PRUNE };
  const before = await state(sut);
  const { stamp: expectedStamp } = await view();
  const stale = { code: 'invalid', message: /重新读取.*重新判断/ };
  const [id] = await Promise.all([
    kernel.dispatch('ai', 'addBranch', { ...add, expectedStamp }),
    expect(kernel.dispatch('ai', 'decideNode', { ...decide, expectedStamp })).rejects.toMatchObject(stale),
  ]);
  const afterAdd = await state(sut, [OLD, id]);
  expect(afterAdd.stamp).toBe(expectedStamp + 1);
  expect(afterAdd.nodes[0]).toEqual(before.nodes[0]);
  expect(afterAdd.nodes[1]).toMatchObject({ id, body: OPEN.body, confirmation: 'unconfirmed' });
  expect(afterAdd.history).toHaveLength(before.history.length + 1);
  await expect(kernel.dispatch('ai', 'addBranch', { ...add, expectedStamp })).rejects.toMatchObject(stale);
  expect(await state(sut, [OLD, id])).toEqual(afterAdd);
  expect(beforeCommit).toHaveBeenCalledTimes(2); // 自举与成功新增。
  expect(sut.clockCalls()).toBe(1);

  const current = await view();
  await expect(kernel.dispatch('ai', 'decideNode', { ...decide, expectedStamp: current.stamp })).resolves.toBe(OLD);
  const afterDecide = await state(sut, [OLD, id]);
  expect(afterDecide.stamp).toBe(current.stamp + 1);
  expect(afterDecide.nodes[0]).toMatchObject({ state: 'prune', confirmation: 'unconfirmed' });
  expect(afterDecide.history).toHaveLength(afterAdd.history.length + 1);
  expect(beforeCommit).toHaveBeenCalledTimes(3);
});

it('明确提供的 expectedStamp 必须是正安全整数；校验不打开写事务', async () => {
  const sut = await setup();
  const { model, store, treeId } = sut;
  const kernel = createKernel(sut);
  const plain = vi.spyOn(store, 'transact');
  const guarded = vi.spyOn(store, 'transactAtStamp');
  const placement = { parentId: ROOT, kind: 'branch' } as const;
  const error = { code: 'invalid', message: /expectedStamp.*正安全整数/ };
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, true, {}, []]) {
    await expect(model.addBranch('ai', treeId, placement, OPEN, bad as number)).rejects.toMatchObject(error);
    await expect(kernel.dispatch('ai', 'decideNode', { treeId, nodeId: OLD, decision: PRUNE, expectedStamp: bad as number }))
      .rejects.toMatchObject(error);
  }
  await expect(kernel.dispatch('ai', 'addBranch', { treeId, placement, draft: OPEN, expectedStamp: undefined }))
    .rejects.toMatchObject(error);
  expect(plain).not.toHaveBeenCalled();
  expect(guarded).not.toHaveBeenCalled();
  expect(sut.clockCalls()).toBe(0);
});

it('存储未实现版本护栏时拒绝有条件的写入，省略条件仍走旧端口', async () => {
  const sut = await setup();
  const { store, clock, treeId } = sut;
  const legacy: TreeStore = { openRead: store.openRead.bind(store), transact: store.transact.bind(store) };
  const transact = vi.spyOn(legacy, 'transact');
  const kernel = createKernel({ store: legacy, clock });
  const add = { treeId, placement: { parentId: ROOT, kind: 'branch' } as const, draft: OPEN };
  const { stamp } = await state(sut);
  await expect(kernel.dispatch('ai', 'addBranch', { ...add, expectedStamp: stamp }))
    .rejects.toMatchObject({ code: 'invalid', message: /不支持.*expectedStamp/ });
  expect(transact).not.toHaveBeenCalled();
  await expect(kernel.dispatch('ai', 'addBranch', add)).resolves.toEqual(expect.any(String));
  expect(transact).toHaveBeenCalledTimes(1);
});

it.each([
  ['标题放平', { title: '误放', state: 'open', refs: [] }, '不要传 draft.title；标题必须写在 draft.body.title。'],
  ['有正文却漏标题', { body: { text: '正文' }, state: 'open', refs: [] }, 'draft.body.title不能为空白'],
  ['标题空白', { body: { title: '  ' }, state: 'open', refs: [] }, 'draft.body.title不能为空白'],
] as const)('%s 时指出标题的正确路径，不写入', async (_name, draft, message) => {
  const sut = await setup();
  const before = await state(sut);
  await expect(sut.model.addBranch('ai', sut.treeId, { parentId: ROOT, kind: 'branch' }, draft as unknown as Draft))
    .rejects.toMatchObject({ code: 'invalid', message });
  expect(await state(sut)).toEqual(before);
});

it.each([['ai', 'supplement'], ['human', 'erratum']] as const)(
  '%s 新增 %s 保存并留痕，不覆写父正文、边、当前变更或确认', async (actor, kind) => {
    const sut = await setup();
    const { model, treeId } = sut;
    await model.decideNode('ai', treeId, OLD, { type: 'setOpenOrKeep', state: 'open', reason: '先打开再补充' });
    const parent = await formation(sut, OLD);
    await model.confirm(treeId, { revisionId: parent.revision.id });
    const before = await state(sut);
    const targets: Draft['refs'] = [
      { kind: 'premise', target: { nodeId: SIBLING, part: '跨支前提' } },
      { kind: 'example', target: { nodeId: OLD } },
      { kind: 'conflict', target: { doc: 'research/facts.md', part: '第一段' } },
    ];
    const id = await model.addBranch(actor, treeId, { parentId: OLD, kind }, { ...OPEN, refs: targets });
    const saved = await formation(sut, id);
    expect(saved.node).toEqual({ id, parentId: OLD, body: OPEN.body, state: 'open', origin: { kind },
      confirmation: 'unconfirmed', currentChange: { revisionId: saved.revision.id, by: actor } });
    expect(saved.revision).toMatchObject({ by: actor, at: NOW, nodeIds: [id, OLD],
      detail: { action: 'addBranch', effects: [{ nodeId: id, afterState: 'open' }] } });
    expect(saved.revision.detail.effects[0]).not.toHaveProperty('beforeState');
    await read(sut, async (snapshot) => {
      expect(snapshot.stamp).toBe(before.stamp + 1);
      expect(await snapshot.readNode(OLD)).toEqual(before.nodes[0]);
      expect(await snapshot.listRefsFrom(OLD, null, 10)).toEqual(before.refs);
      const refs = await snapshot.listRefsFrom(id, null, 10);
      expect(refs.map(({ kind: relation, target }) => ({ kind: relation, target }))).toEqual(targets);
      expect(new Set(refs.map((ref) => ref.id)).size).toBe(3);
      expect(refs.every((ref) => ref.from === id)).toBe(true);
      expect(await snapshot.listRevisions(null, null, 10)).toHaveLength(before.history.length + 1);
    });
    // 待确认项可直接提交；节点清单是显示数据，真正的确认只按 effects 与事务中的当前指针绑定。
    const pending = (await read(sut, (snapshot) => snapshot.listUnconfirmed([actor], null, 10)))[0];
    if (pending?.revisionId === undefined) throw new Error('预期待确认的日常形成记录');
    const selected = { ...pending, nodeIds: [OLD] };
    const confirmationId = await model.confirm(treeId, selected);
    await read(sut, async (snapshot) => {
      expect(await snapshot.readNode(OLD)).toEqual(before.nodes[0]);
      expect(await snapshot.readNode(id)).toEqual({ ...saved.node, confirmation: 'humanConfirmed' });
      expect(await snapshot.readRevision(confirmationId)).toMatchObject({
        by: 'human', kind: 'confirmation', at: NOW, nodeIds: [id], detail: { target: { revisionId: saved.revision.id } },
      });
    });
    expect(sut.clockCalls()).toBe(4);
  },
);

it.each(['human', 'ai'] as const)('%s 的四种日常决定生效且始终独立于人确认', async (actor) => {
  const sut = await setup();
  const { treeId, model } = sut;
  const original = await state(sut);
  expect(await model.decideNode(actor, treeId, OLD, PRUNE)).toBe(OLD);
  const pruned = await formation(sut, OLD);
  expect(pruned.node).toMatchObject({ state: 'prune', confirmation: 'unconfirmed',
    pruneReason: PRUNE.reason, reviveWhen: PRUNE.reviveWhen });
  expect(pruned.revision.detail).toEqual({ action: 'prune', reason: PRUNE.reason, reviveWhen: PRUNE.reviveWhen,
    effects: [{ nodeId: OLD, beforeState: 'keep', afterState: 'prune' }] });

  expect(await model.decideNode(actor, treeId, OLD, { type: 'revive', state: 'keep', reason: '发现新证据' })).toBe(OLD);
  const revived = await formation(sut, OLD);
  expect(revived.node).not.toHaveProperty('pruneReason');
  expect(revived.node).not.toHaveProperty('reviveWhen');
  expect(revived.revision.detail).toEqual({ action: 'revive', state: 'keep', reason: '发现新证据',
    previousPrune: { pruneReason: PRUNE.reason, reviveWhen: PRUNE.reviveWhen },
    effects: [{ nodeId: OLD, beforeState: 'prune', afterState: 'keep' }] });

  expect(await model.decideNode(actor, treeId, OLD,
    { type: 'setOpenOrKeep', state: 'open', reason: '还需要复核' })).toBe(OLD);
  const opened = await formation(sut, OLD);
  expect(opened.revision.detail).toEqual({ action: 'setOpenOrKeep', reason: '还需要复核', state: 'open',
    effects: [{ nodeId: OLD, beforeState: 'keep', afterState: 'open' }] });
  expect(opened.node.body).toEqual(original.nodes[0]?.body);

  const id = await model.addBranch(actor, treeId, { replacesId: OLD }, OPEN);
  const proposed = await formation(sut, id);
  await model.confirm(treeId, { revisionId: proposed.revision.id });
  expect(await read(sut, (snapshot) => snapshot.readNode(id))).toEqual({ ...proposed.node, confirmation: 'humanConfirmed' });
  expect((await formation(sut, OLD)).node).toEqual(opened.node);
  expect(proposed.node.origin).toEqual({ kind: 'replacement', replacesId: OLD, status: 'proposed' });
  expect(proposed.node.parentId).toBe(ROOT);

  expect(await model.decideNode(actor, treeId, id, REPLACEMENT)).toBe(id);
  const applied = await formation(sut, id);
  const replaced = await formation(sut, OLD);
  expect(applied.revision).toEqual(replaced.revision);
  expect(applied.revision.detail).toEqual({
    action: 'applyReplacement', reason: REPLACEMENT.reason, reviveWhen: REPLACEMENT.reviveWhen,
    replacement: { oldId: OLD, newId: id }, effects: [
      { nodeId: id, beforeState: 'open', afterState: 'open' },
      { nodeId: OLD, beforeState: 'open', afterState: 'prune' },
    ],
  });
  expect(applied.node.origin).toEqual({ kind: 'replacement', replacesId: OLD, status: 'applied' });
  expect(applied.node.parentId).toBe(ROOT);
  expect(replaced.node.body).toEqual(original.nodes[0]?.body);
  for (const { node, revision } of [pruned, revived, opened, applied, replaced]) {
    expect(revision).toMatchObject({ by: actor, at: NOW, kind: 'formation' });
    expect(node.confirmation).toBe('unconfirmed');
    expect(node.currentChange).toEqual({ revisionId: revision.id, by: actor });
  }
  const target = { revisionId: applied.revision.id };
  const confirmationId = await model.confirm(treeId, target);
  await read(sut, async (snapshot) => {
    expect(await snapshot.readNode(id)).toEqual({ ...applied.node, confirmation: 'humanConfirmed' });
    expect(await snapshot.readNode(OLD)).toEqual({ ...replaced.node, confirmation: 'humanConfirmed' });
    expect(await snapshot.listRefsFrom(OLD, null, 10)).toEqual(original.refs);
    expect(await snapshot.readRevision(applied.revision.id)).toEqual(applied.revision);
    expect(await snapshot.readRevision(confirmationId)).toMatchObject({ nodeIds: [id, OLD],
      kind: 'confirmation', by: 'human', detail: { target } });
    expect((await snapshot.listRevisions(OLD, null, 20)).some((entry) => entry.source === '手稿 #1')).toBe(true);
  });
  const beforeReject = await state(sut, [id, OLD]);
  await expect(model.confirm(treeId, target)).rejects.toMatchObject({ code: 'invalid' });
  await expect(model.decideNode(actor, treeId, id, REPLACEMENT)).rejects.toMatchObject({ code: 'invalid' });
  expect(await state(sut, [id, OLD])).toEqual(beforeReject);
  expect(sut.clockCalls()).toBe(7);
});

it('状态未载仍可定为留或未决；复活沿用手稿部分剪除信息，不补造缺项', async () => {
  const sut = await setup();
  const { model, treeId } = sut;
  await model.decideNode('ai', treeId, UNKNOWN, { type: 'setOpenOrKeep', state: 'keep', reason: '状态首次记录' });
  const assigned = await formation(sut, UNKNOWN);
  expect(assigned.revision.detail.effects).toEqual([{ nodeId: UNKNOWN, beforeState: null, afterState: 'keep' }]);
  expect(assigned.node.body).toEqual({ title: '状态与确认均未载', note: '保留原说明' });
  await model.decideNode('human', treeId, LEGACY, { type: 'revive', state: 'open', reason: '重新考虑' });
  const revived = await formation(sut, LEGACY);
  expect(revived.revision.detail).toMatchObject({ previousPrune: { pruneReason: '原手稿理由' } });
  if (revived.revision.detail.action !== 'revive') throw new Error('预期重新启用修订');
  expect(revived.revision.detail.previousPrune).toEqual({ pruneReason: '原手稿理由' });
  expect(revived.node).not.toHaveProperty('pruneReason');
  expect(revived.node).not.toHaveProperty('reviveWhen');
});

it('初始即剪的理由和复活条件在复活后仍能从原形成记录回查', async () => {
  const sut = await setup();
  const { model, treeId } = sut;
  const draft: Draft = { ...OPEN, state: 'prune', pruneReason: ' 原始剪除理由 ', reviveWhen: ' 原始复活条件 ' };
  const id = await model.addBranch('ai', treeId, { parentId: ROOT, kind: 'branch' }, draft);
  const before = await formation(sut, id);
  expect(before.node).toMatchObject({ state: 'prune', pruneReason: draft.pruneReason, reviveWhen: draft.reviveWhen });
  expect(before.revision.detail.effects).toEqual([{ nodeId: id, afterState: 'prune' }]);
  await model.decideNode('human', treeId, id, { type: 'revive', state: 'keep', reason: '条件已满足' });
  const after = await formation(sut, id);
  expect(after.revision.detail).toMatchObject({ previousPrune: { pruneReason: draft.pruneReason, reviveWhen: draft.reviveWhen } });
  expect(after.node).not.toHaveProperty('pruneReason');
  const original = await read(sut, (snapshot) => snapshot.readRevision(before.revision.id));
  expect(original).toEqual(before.revision);
  expect(original?.summary).toContain(draft.pruneReason);
  expect(original?.summary).toContain(draft.reviveWhen);
});

it.each(['候选', '旧判断'] as const)('替代的%s后续变更时，确认只更新仍绑定替代记录的一侧', async (side) => {
  const sut = await setup();
  const { treeId, model } = sut;
  const candidate = await model.addBranch('ai', treeId, { replacesId: OLD }, OPEN);
  await model.decideNode('ai', treeId, candidate, REPLACEMENT);
  const applied = await formation(sut, candidate);
  const changedId = side === '候选' ? candidate : OLD;
  const unchangedId = side === '候选' ? OLD : candidate;
  const next: Decision = side === '候选'
    ? { type: 'setOpenOrKeep', state: 'keep', reason: '候选另有变动' }
    : { type: 'revive', state: 'open', reason: '旧判断另有变动' };
  await model.decideNode('ai', treeId, changedId, next);
  const changed = await formation(sut, changedId);
  const target = { revisionId: applied.revision.id };
  const before = await state(sut, [changedId, unchangedId]);
  expect(before.pending.find((item) => item.revisionId === target.revisionId)?.nodeIds).toEqual([unchangedId]);
  const confirmation = await model.confirm(treeId, target);
  await read(sut, async (snapshot) => {
    expect(await snapshot.readRevision(confirmation)).toMatchObject({ nodeIds: [unchangedId], detail: { target } });
    expect(await snapshot.readNode(changedId)).toEqual(changed.node);
    expect(await snapshot.readNode(unchangedId)).toEqual({ ...before.nodes[1], confirmation: 'humanConfirmed' });
    const pending = await snapshot.listUnconfirmed(['ai'], null, 10);
    expect(pending.map(({ revisionId }) => revisionId)).toEqual([changed.revision.id]);
  });
});

it('目标失效、不存在、非日常形成或重复时拒绝确认，不写日志', async () => {
  const sut = await setup();
  const { model, treeId } = sut;
  const id = await model.addBranch('ai', treeId, { parentId: ROOT, kind: 'branch' }, OPEN);
  const created = await formation(sut, id);
  await model.decideNode('ai', treeId, id, PRUNE);
  await model.decideNode('human', treeId, SIBLING, { type: 'setOpenOrKeep', state: 'keep', reason: '替换导入版本' });
  const pruned = await formation(sut, id);
  const confirmed = await model.confirm(treeId, { revisionId: pruned.revision.id });
  const before = await state(sut, [id, OLD, SIBLING]);
  const imported = before.history.find((revision) => revision.by === 'import')!;
  const invalid: ConfirmTarget[] = [
    { revisionId: created.revision.id }, { revisionId: pruned.revision.id }, { revisionId: confirmed },
    { revisionId: imported.id }, { seedNodeId: SIBLING }, { seedNodeId: OLD },
    { revisionId: 'x', seedNodeId: 'y' } as unknown as ConfirmTarget,
  ];
  for (const target of invalid) await expect(model.confirm(treeId, target)).rejects.toMatchObject({ code: 'invalid' });
  await expect(model.confirm(treeId, { revisionId: 'absent' })).rejects.toMatchObject({ code: 'missing' });
  await expect(model.confirm(treeId, { seedNodeId: 'absent' })).rejects.toMatchObject({ code: 'missing' });
  expect(await state(sut, [id, OLD, SIBLING])).toEqual(before);
  expect(sut.clockCalls()).toBe(4);
});

it('拒绝不合规写意图与请求夹带字段；校验失败不改树、日志或索引', async () => {
  const sut = await setup();
  const { model, treeId } = sut;
  const candidate = await model.addBranch('ai', treeId, { replacesId: LEGACY }, OPEN);
  const prunedCandidate = await model.addBranch('ai', treeId, { replacesId: OLD },
    { ...OPEN, state: 'prune', pruneReason: '候选剪除', reviveWhen: '出现证据' });
  const before = await state(sut, [OLD, candidate, prunedCandidate]);
  const parent: Placement = { parentId: LEGACY, kind: 'branch' };
  const badDrafts: unknown[] = [
    null, { ...OPEN, body: { title: ' \t ' } }, { ...OPEN, state: null }, { ...OPEN, refs: undefined },
    { ...OPEN, state: 'prune', pruneReason: '理由' }, { ...OPEN, state: 'prune', pruneReason: '　', reviveWhen: '条件' },
    { ...OPEN, confirmation: 'humanConfirmed' }, { ...OPEN, actor: 'human' }, { ...OPEN, id: OLD },
    { ...OPEN, refs: [{ kind: 'premise', target: { nodeId: ROOT } }] },
    { ...OPEN, refs: [{ kind: 'example', target: { nodeId: OLD, doc: 'ab.md' } }] },
    { ...OPEN, refs: [{ kind: 'unknown', target: { nodeId: OLD } }] },
  ];
  for (const draft of badDrafts) {
    await expect(model.addBranch('ai', treeId, parent, draft as Draft)).rejects.toMatchObject({ code: 'invalid' });
  }
  for (const placement of [{ parentId: ROOT, kind: 'branch', replacesId: OLD }, { replacesId: ROOT }]) {
    await expect(model.addBranch('ai', treeId, placement as Placement, OPEN)).rejects.toMatchObject({ code: 'invalid' });
  }
  const badDecisions: [string, unknown][] = [
    [ROOT, PRUNE], [ROOT, { type: 'setOpenOrKeep', state: 'keep', reason: '无效' }],
    [OLD, { ...PRUNE, reason: ' ' }], [OLD, { ...PRUNE, reviveWhen: '\t' }], [LEGACY, PRUNE],
    [OLD, { type: 'revive', state: 'keep', reason: '并未剪除' }],
    [LEGACY, { type: 'revive', state: 'prune', reason: '目标无效' }],
    [OLD, { type: 'setOpenOrKeep', state: 'keep', reason: '重复状态' }],
    [LEGACY, { type: 'setOpenOrKeep', state: 'keep', reason: '已剪须复活' }],
    [candidate, { type: 'setOpenOrKeep', state: 'keep', reason: '候选不能转换' }],
    [OLD, REPLACEMENT], [candidate, REPLACEMENT], [prunedCandidate, REPLACEMENT],
    [OLD, { ...PRUNE, confirmation: 'humanConfirmed' }], [OLD, { type: 'confirm', reason: '越权' }],
  ];
  for (const [id, decision] of badDecisions) {
    await expect(model.decideNode('ai', treeId, id, decision as Decision)).rejects.toMatchObject({ code: 'invalid' });
  }
  await expect(model.addBranch('import' as DailyActor, treeId, parent, OPEN)).rejects.toMatchObject({ code: 'invalid' });
  await expect(model.addBranch('ai', '', parent, OPEN)).rejects.toMatchObject({ code: 'invalid' });
  await expect(model.addBranch('ai', 'absent', parent, OPEN)).rejects.toMatchObject({ code: 'missing' });
  await expect(model.addBranch('ai', treeId, { parentId: 'absent', kind: 'branch' }, OPEN)).rejects.toMatchObject({ code: 'missing' });
  await expect(model.addBranch('ai', treeId, parent, { ...OPEN, refs: [{ kind: 'example', target: { nodeId: 'absent' } }] }))
    .rejects.toMatchObject({ code: 'missing' });
  await expect(model.decideNode('ai', treeId, 'absent', PRUNE)).rejects.toMatchObject({ code: 'missing' });
  expect(await state(sut, [OLD, candidate, prunedCandidate])).toEqual(before);
  expect(sut.clockCalls()).toBe(2);
});

it('替代或确认的发布前失败回滚两端、确认索引、引用和形成记录，故障解除可重试', async () => {
  let fail = false;
  const pending: { count: number; id?: string } = { count: 0 };
  const sut = await setup(async (_id, _mode, delta) => {
    if (!fail) return;
    pending.count = delta.nodes.length;
    pending.id = delta.revisions[0]?.id;
    throw new Error('测试：发布前写入失败');
  });
  const { model, treeId } = sut;
  const id = await model.addBranch('ai', treeId, { replacesId: OLD }, OPEN);
  await model.confirm(treeId, { revisionId: (await formation(sut, id)).revision.id });
  const beforeApply = await state(sut, [id, OLD]);
  fail = true;
  await expect(model.decideNode('ai', treeId, id, REPLACEMENT)).rejects.toMatchObject({ code: 'storage' });
  expect(pending.count).toBe(2);
  expect(pending.id).toBeDefined();
  expect(await state(sut, [id, OLD])).toEqual(beforeApply);
  fail = false;
  expect(await model.decideNode('ai', treeId, id, REPLACEMENT)).toBe(id);
  const applied = await formation(sut, id);
  expect(applied.revision.id).toBe(pending.id);

  const target = { revisionId: applied.revision.id };
  const beforeConfirm = await state(sut, [id, OLD]);
  fail = true;
  await expect(model.confirm(treeId, target)).rejects.toMatchObject({ code: 'storage' });
  expect(pending.count).toBe(2);
  expect(await state(sut, [id, OLD])).toEqual(beforeConfirm);
  fail = false;
  const confirmed = await model.confirm(treeId, target);
  expect(confirmed).toBe(pending.id);
  expect((await state(sut, [id, OLD])).nodes.map((node) => node?.confirmation)).toEqual(['humanConfirmed', 'humanConfirmed']);
});

it('两模型同树同刻并发新增仍分配不同节点、修订和引用 ID', async () => {
  const sut = await setup();
  const { treeId, model, store, clock } = sut;
  const other = createWriteModel(store, clock);
  const placement = { parentId: ROOT, kind: 'branch' } as const;
  const draft: Draft = { ...OPEN, refs: [{ kind: 'example', target: { nodeId: OLD } }] };
  const ids = await Promise.all([model.addBranch('ai', treeId, placement, draft), other.addBranch('human', treeId, placement, draft)]);
  expect(new Set(ids).size).toBe(2);
  await read(sut, async (snapshot) => {
    const refs = await snapshot.listRefsTo(OLD, null, 10);
    expect(new Set(refs.map(({ id }) => id)).size).toBe(2);
    expect(new Set(refs.map(({ from }) => from))).toEqual(new Set(ids));
    expect((await snapshot.listRevisions(null, null, 10)).map(({ by }) => by)).toEqual(['human', 'ai', 'import']);
  });
});
