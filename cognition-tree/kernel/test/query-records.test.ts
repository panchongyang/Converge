import { describe, expect, it } from 'vitest';
import { createWriteModel } from '../src/models';
import { createQueries } from '../src/queries';
import { MemoryTreeStore } from '../src/storage/memory';
import type {
  CognitionNode, ConfirmTarget, FormationRevision, PendingTarget, ReadSnapshot, Revision,
  RevisionActor, TreeStore, WriteTransaction,
} from '../src/types';

/** 只记录公开端口的实际读取，不把索引内部结构暴露给查询层。 */
class MeasuredStore implements TreeStore {
  readonly memory = new MemoryTreeStore();
  opens = 0;
  closes = 0;
  nodeReads = 0;
  rowReads = 0;
  revisionReads = 0;
  readonly historyCalls: Array<{ nodeId: string | null; after: string | null; limit: number; returned: number }> = [];
  readonly pendingCalls: Array<{ by: RevisionActor[]; after: ConfirmTarget | null; limit: number; returned: number }> = [];
  /** 可替换某次修订读取以测试损坏指针；默认不改快照行为。 */
  revisionOverride?: (id: string, snapshot: ReadSnapshot) => Promise<Revision | null>;

  /**
   * 透传真实事务端口；数据建立与正式模型提交都由同一存储实现执行。
   * @param treeId 目标树
   * @param mode 已有树或自举事务
   * @param work 事务工作
   */
  transact<T>(treeId: string, mode: 'existing' | 'createNew', work: (tx: WriteTransaction) => T | Promise<T>): Promise<T> {
    return this.memory.transact(treeId, mode, work);
  }

  /**
   * 打开真实快照，并在其外层记录点查/有界列表与释放次数。
   * @param treeId 目标树
   */
  async openRead(treeId: string): Promise<ReadSnapshot> {
    this.opens++;
    const snapshot = await this.memory.openRead(treeId);
    return {
      stamp: snapshot.stamp, rootId: snapshot.rootId,
      readNode: async (id) => { this.nodeReads++; return snapshot.readNode(id); },
      readNodeRow: async (id) => { this.rowReads++; return snapshot.readNodeRow(id); },
      readRevision: async (id) => {
        this.revisionReads++;
        return this.revisionOverride ? this.revisionOverride(id, snapshot) : snapshot.readRevision(id);
      },
      listChildren: snapshot.listChildren.bind(snapshot),
      listRefsFrom: snapshot.listRefsFrom.bind(snapshot),
      listRefsTo: snapshot.listRefsTo.bind(snapshot),
      listRevisions: async (nodeId, after, limit) => {
        const rows = await snapshot.listRevisions(nodeId, after, limit);
        this.historyCalls.push({ nodeId, after, limit, returned: rows.length }); return rows;
      },
      listUnconfirmed: async (by, after, limit) => {
        const rows = await snapshot.listUnconfirmed(by, after, limit);
        this.pendingCalls.push({ by, after, limit, returned: rows.length }); return rows;
      },
      close: async () => { this.closes++; await snapshot.close(); },
    };
  }
}

/**
 * 建立有导入判断的真实模型/查询组合。clock 只为真实新修订提供时刻，不回填导入历史。
 * @returns 注入同一存储的读写入口和可观察计数
 */
async function setup() {
  const store = new MeasuredStore();
  let tick = 0;
  const model = createWriteModel(store, { now: () => new Date(Date.UTC(2026, 10, 20, 12, 0, tick++)).toISOString() });
  await model.bootstrapTree({
    treeId: 'T', rootId: 'R', refs: [],
    nodes: [
      { id: 'R', parentId: null, body: { title: '根' }, origin: { kind: 'branch' } },
      { id: 'I1', parentId: 'R', body: { title: '待确认的导入一' }, origin: { kind: 'branch' }, state: 'open', confirmation: 'unconfirmed' },
      { id: 'I2', parentId: 'R', body: { title: '待确认的导入二' }, origin: { kind: 'branch' }, state: 'keep', confirmation: 'unconfirmed' },
      { id: 'I3', parentId: 'R', body: { title: '确认程度未载' }, origin: { kind: 'branch' } },
      { id: 'I4', parentId: 'R', body: { title: '已确认的导入' }, origin: { kind: 'branch' }, confirmation: 'humanConfirmed' },
    ],
    history: [{ kind: 'formation', by: 'import', at: '2026-11-19', nodeIds: ['I1'], summary: '手稿的形成', source: '手稿 #1' }],
  });
  return { store, model, queries: createQueries(store) };
}

/**
 * 从返回目标中只取其稳定确认键。
 * @param item 已读到的待确认项
 */
function target(item: PendingTarget): ConfirmTarget {
  return item.revisionId !== undefined ? { revisionId: item.revisionId } : { seedNodeId: item.seedNodeId };
}

/**
 * 生成一个新判断的最小有效草稿；确认程度不能由草稿自报。
 * @param title 新判断标题
 */
function draft(title: string) { return { body: { title }, state: 'open' as const, refs: [] }; }

describe('readNode：在一致读中带回当前形成记录', () => {
  it('正文、剪除信息、执行者、确认程度与当前形成明细可直接审阅', async () => {
    const { store, model, queries } = await setup();
    await model.decideNode('ai', 'T', 'I1', { type: 'prune', reason: '观察与原判断冲突', reviveWhen: '新的反例被解释' });
    const detail = await queries.readNode('T', 'I1');
    expect(detail.node.body.title).toBe('待确认的导入一'); expect(detail.node.state).toBe('prune');
    expect(detail.node.confirmation).toBe('unconfirmed'); expect(detail.node.currentChange?.by).toBe('ai');
    expect(detail.currentChange).toMatchObject({
      id: detail.node.currentChange!.revisionId, kind: 'formation', by: 'ai',
      detail: { action: 'prune', reason: '观察与原判断冲突', reviveWhen: '新的反例被解释', effects: [{ nodeId: 'I1', beforeState: 'open', afterState: 'prune' }] },
    });
    expect(store.nodeReads).toBe(1); expect(store.revisionReads).toBe(1);
    expect(store.historyCalls).toEqual([]); expect(store.pendingCalls).toEqual([]);
    expect(store.opens).toBe(1); expect(store.closes).toBe(1);
    await model.confirm('T', { revisionId: detail.currentChange!.id });
    const confirmed = await queries.readNode('T', 'I1');
    expect(confirmed.node.state).toBe('prune'); expect(confirmed.node.confirmation).toBe('humanConfirmed');
    expect(confirmed.currentChange).toEqual(detail.currentChange);
  });

  it('导入节点没有日常变更时不补造 currentChange，手稿缺项保持省略', async () => {
    const { store, queries } = await setup();
    const detail = await queries.readNode('T', 'I3');
    expect('currentChange' in detail).toBe(false);
    expect('state' in detail.node).toBe(false); expect('confirmation' in detail.node).toBe(false);
    expect(store.revisionReads).toBe(0);
  });

  it('缺失判断和损坏指针均失败并释放快照，不把确认记录冒充当前形成', async () => {
    const { store, model, queries } = await setup();
    await expect(queries.readNode('T', 'missing')).rejects.toMatchObject({ code: 'missing' });
    expect(store.opens).toBe(store.closes);
    await model.decideNode('human', 'T', 'I1', { type: 'setOpenOrKeep', state: 'keep', reason: '范围已清楚' });
    store.revisionOverride = async () => null;
    await expect(queries.readNode('T', 'I1')).rejects.toMatchObject({ code: 'storage' });
    store.revisionOverride = async (id) => ({
      id, kind: 'confirmation', by: 'human', at: '2026-11-20T12:00:00Z', nodeIds: ['I1'], summary: '不是形成', detail: { target: { seedNodeId: 'I1' } },
    });
    await expect(queries.readNode('T', 'I1')).rejects.toMatchObject({ code: 'storage' });
    expect(store.opens).toBe(store.closes);
  });
});

describe('readHistory：有界的树/节点时间索引分页', () => {
  it('整树从新到旧分页；nodeId 只查该判断；导入日期和出处原样返回', async () => {
    const { store, model, queries } = await setup();
    await model.decideNode('ai', 'T', 'I1', { type: 'setOpenOrKeep', state: 'keep', reason: '一次变更' });
    const firstChange = (await queries.readNode('T', 'I1')).currentChange!;
    await model.confirm('T', { revisionId: firstChange.id });
    await model.decideNode('human', 'T', 'I2', { type: 'setOpenOrKeep', state: 'open', reason: '二次变更' });
    const first = await queries.readHistory('T', { limit: 2 });
    expect(first.items.map((item) => item.kind)).toEqual(['formation', 'confirmation']);
    expect(first.next).toBe(first.items[1].id);
    const second = await queries.readHistory('T', { limit: 2, after: first.next });
    expect(second.items[0].id).toBe(firstChange.id);
    expect(second.items[1]).toMatchObject({ by: 'import', at: '2026-11-19', source: '手稿 #1' });
    expect(second.next).toBeUndefined();
    const nodeHistory = await queries.readHistory('T', { nodeId: 'I1', limit: 10 });
    expect(nodeHistory.items).toHaveLength(3);
    expect(nodeHistory.items.every((item) => item.nodeIds.includes('I1'))).toBe(true);
    expect(store.historyCalls.map((call) => [call.nodeId, call.limit])).toEqual([[null, 3], [null, 3], ['I1', 11]]);
    expect(store.opens).toBe(store.closes);
  });

  it('空历史没有 next；缺失节点和无效起点不静默退回第一项', async () => {
    const { queries, store } = await setup();
    expect(await queries.readHistory('T', { nodeId: 'I3', limit: 1 })).toEqual({ items: [] });
    await expect(queries.readHistory('T', { nodeId: 'missing', limit: 1 })).rejects.toMatchObject({ code: 'missing' });
    await expect(queries.readHistory('T', { limit: 1, after: 'unknown' })).rejects.toMatchObject({ code: 'invalid' });
    expect(store.opens).toBe(store.closes);
  });
});

describe('readUnconfirmed：直接可确认的索引项', () => {
  it('执行者筛选显式生效；人执行未自动确认，导入未载确认程度不列入', async () => {
    const { queries, model } = await setup();
    await model.addBranch('human', 'T', { parentId: 'R', kind: 'branch' }, draft('人的新判断'));
    await model.addBranch('ai', 'T', { parentId: 'R', kind: 'branch' }, draft('AI 的新判断'));
    const mixed = await queries.readUnconfirmed('T', { by: ['ai', 'import'], limit: 10 });
    expect(mixed.items).toHaveLength(3);
    expect(mixed.items[0]).toMatchObject({ by: 'ai' });
    expect(mixed.items.slice(1)).toEqual([{ seedNodeId: 'I1', title: '待确认的导入一' }, { seedNodeId: 'I2', title: '待确认的导入二' }]);
    const human = await queries.readUnconfirmed('T', { by: ['human'], limit: 10 });
    expect(human.items).toHaveLength(1); expect(human.items[0]).toMatchObject({ by: 'human' });
    expect((await queries.readUnconfirmed('T', { by: ['import'], limit: 10 })).items).toHaveLength(2);
  });

  it('形成记录按时间从新到旧，导入排后，next 精确对应本页末项', async () => {
    const { store, queries, model } = await setup();
    for (let index = 0; index < 5; index++) await model.addBranch(index % 2 ? 'human' : 'ai', 'T', { parentId: 'R', kind: 'branch' }, draft(`判断 ${index}`));
    const by: RevisionActor[] = ['human', 'ai', 'import'];
    const items: PendingTarget[] = [];
    let after: ConfirmTarget | undefined;
    for (let round = 0; round < 10; round++) {
      const page = await queries.readUnconfirmed('T', { by, limit: 2, after });
      items.push(...page.items);
      if (!page.next) break;
      expect(page.next).toEqual(target(page.items[page.items.length - 1]));
      after = page.next;
    }
    expect(items).toHaveLength(7); expect(new Set(items.map((item) => JSON.stringify(target(item)))).size).toBe(7);
    const formed = items.filter((item) => item.revisionId !== undefined);
    expect(formed.map((item) => item.at)).toEqual([...formed.map((item) => item.at)].sort().reverse());
    expect(items.slice(-2).map(target)).toEqual([{ seedNodeId: 'I1' }, { seedNodeId: 'I2' }]);
    expect(store.pendingCalls.every((call) => call.limit === 3 && call.returned <= 3)).toBe(true);
    expect(store.nodeReads).toBe(0); expect(store.rowReads).toBe(0); expect(store.revisionReads).toBe(0);
  });

  it('确认末项后仍可按它续读，确认完成的形成/导入目标立即从新查询消失', async () => {
    const { queries, model } = await setup();
    const added = await model.addBranch('ai', 'T', { parentId: 'R', kind: 'branch' }, draft('新判断'));
    const first = await queries.readUnconfirmed('T', { by: ['ai', 'import'], limit: 1 });
    const firstTarget = target(first.items[0]);
    await model.confirm('T', firstTarget);
    expect((await queries.readUnconfirmed('T', { by: ['ai'], limit: 10 })).items).toEqual([]);
    expect((await queries.readNode('T', added)).node.confirmation).toBe('humanConfirmed');
    const next = await queries.readUnconfirmed('T', { by: ['ai', 'import'], limit: 1, after: first.next });
    expect(next.items[0]).toMatchObject({ seedNodeId: 'I1' });
    await model.confirm('T', target(next.items[0]));
    const last = await queries.readUnconfirmed('T', { by: ['ai', 'import'], limit: 10, after: next.next });
    expect(last.items).toEqual([{ seedNodeId: 'I2', title: '待确认的导入二' }]);
  });

  it('后续变更覆盖旧 currentChange 后，旧目标不再出现', async () => {
    const { queries, model } = await setup();
    await model.decideNode('ai', 'T', 'I1', { type: 'setOpenOrKeep', state: 'keep', reason: '先留' });
    const first = (await queries.readNode('T', 'I1')).currentChange!;
    await model.decideNode('ai', 'T', 'I1', { type: 'prune', reason: '后来发现反例', reviveWhen: '反例被解释' });
    const current = (await queries.readNode('T', 'I1')).currentChange!;
    const pending = await queries.readUnconfirmed('T', { by: ['ai', 'import'], limit: 10 });
    expect(pending.items.some((item) => item.revisionId === first.id)).toBe(false);
    expect(pending.items.some((item) => item.revisionId === current.id)).toBe(true);
    expect(pending.items.some((item) => item.seedNodeId === 'I1')).toBe(false);
  });

  it('替代形成只列一项；一侧后来变更时 nodeIds 只含仍指向该形成的判断', async () => {
    const { queries, model } = await setup();
    const replacement = await model.addBranch('ai', 'T', { replacesId: 'I1' }, draft('新的替代判断'));
    await model.decideNode('ai', 'T', replacement, { type: 'applyReplacement', reason: '新判断解释更多', reviveWhen: '旧依据恢复' });
    const applied = (await queries.readNode('T', replacement)).currentChange!;
    let pending = await queries.readUnconfirmed('T', { by: ['ai'], limit: 10 });
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({ revisionId: applied.id, nodeIds: ['I1', replacement] });
    await model.decideNode('ai', 'T', replacement, { type: 'prune', reason: '新判断也有问题', reviveWhen: '问题已解决' });
    pending = await queries.readUnconfirmed('T', { by: ['ai'], limit: 10 });
    expect(pending.items.find((item) => item.revisionId === applied.id)?.nodeIds).toEqual(['I1']);
    await model.confirm('T', { revisionId: applied.id });
    expect((await queries.readUnconfirmed('T', { by: ['ai'], limit: 10 })).items).toHaveLength(1);
    expect((await queries.readNode('T', 'I1')).node.confirmation).toBe('humanConfirmed');
    expect((await queries.readNode('T', replacement)).node.confirmation).toBe('unconfirmed');
  });

  it('超过 5 MB 且混入大量已确认/人执行记录，读取量仍只随页大小增长', async () => {
    const store = new MeasuredStore();
    const rows: CognitionNode[] = [{ id: 'R', parentId: null, body: { title: '根' }, origin: { kind: 'branch' } }];
    const records: FormationRevision[] = [];
    for (let index = 0; index < 3000; index++) {
      const id = `N${index}`; const revisionId = `V${index}`;
      const by = index < 5 ? 'ai' : index % 2 === 0 ? 'human' : 'ai';
      rows.push({
        id, parentId: 'R', body: { title: id, text: '证'.repeat(600) }, origin: { kind: 'branch' }, state: 'open',
        currentChange: { revisionId, by }, confirmation: index < 5 || by === 'human' ? 'unconfirmed' : 'humanConfirmed',
      });
      records.push({
        id: revisionId, kind: 'formation', by, at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        nodeIds: [id], summary: id, detail: { action: 'addBranch', effects: [{ nodeId: id, afterState: 'open' }] },
      });
    }
    expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeGreaterThan(5_000_000);
    await store.transact('T', 'createNew', (tx) => { for (const row of rows) tx.writeNode(row); for (const record of records) tx.appendRevision(record); });
    const queries = createQueries(store);
    const first = await queries.readUnconfirmed('T', { by: ['ai'], limit: 3 });
    const second = await queries.readUnconfirmed('T', { by: ['ai'], limit: 3, after: first.next });
    expect([...first.items, ...second.items].map((item) => item.revisionId)).toEqual(['V4', 'V3', 'V2', 'V1', 'V0']);
    expect(second.next).toBeUndefined();
    expect(store.pendingCalls.map((call) => [call.limit, call.returned])).toEqual([[4, 4], [4, 2]]);
    expect(store.nodeReads).toBe(0); expect(store.rowReads).toBe(0); expect(store.revisionReads).toBe(0);
    expect(store.opens).toBe(store.closes);
  });
});

describe('查询分页输入护栏', () => {
  it('拒绝缺省/非法页大小、执行者与混合末项，不打开快照', async () => {
    const { store, queries } = await setup();
    for (const limit of [undefined, 0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(queries.readHistory('T', { limit } as never)).rejects.toMatchObject({ code: 'invalid' });
    }
    for (const by of [undefined, [], ['unknown']]) {
      await expect(queries.readUnconfirmed('T', { by, limit: 1 } as never)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(queries.readUnconfirmed('T', { by: ['ai'], limit: 1, after: { revisionId: 'a', seedNodeId: 'b' } as never })).rejects.toMatchObject({ code: 'invalid' });
    await expect(queries.readNode('T', '')).rejects.toMatchObject({ code: 'invalid' });
    expect(store.opens).toBe(0);
  });
});
