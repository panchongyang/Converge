import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWriteModel } from '../src/models';
import { createQueries } from '../src/queries';
import type { Focus, Queries } from '../src/queries';
import { MemoryTreeStore } from '../src/storage/memory';
import type { Budget, CognitionNode, Expand, ReadSnapshot, Ref, TreeStore, TreeView, WriteTransaction } from '../src/types';

/** 所有测试都显式传范围与预算，不依赖产品 UI 的默认阅读参数。 */
const baseExpand: Expand = { subtreeDepth: 0, jumpHops: 0, direction: 'out', jumpFrom: 'expanded', afterJumpDepth: 0 };
const large: Budget = { maxScans: 100_000, maxNodes: 10_000, maxBytes: 10_000_000 };

/**
 * 生成正式 MemoryTreeStore 的测试节点；正文长短与遍历轻行互相独立。
 * @param id 稳定节点 ID
 * @param parentId 原树父节点，根为 null
 * @param title 标题，缺省仅供测试数据生成使用
 */
function node(id: string, parentId: string | null, title = id): CognitionNode {
  return { id, parentId, body: { title }, origin: { kind: 'branch' }, state: 'open' };
}

/**
 * 生成一条树内引用，测试中引用 ID 决定稳定扫描顺序。
 * @param id 引用 ID
 * @param from 原始起点
 * @param to 原始目标
 */
function ref(id: string, from: string, to: string): Ref { return { id, from, kind: 'example', target: { nodeId: to } }; }

/** 通过端口记录实际查询调用，不读取或重建存储索引。 */
class MeasuredStore implements TreeStore {
  readonly memory = new MemoryTreeStore();
  scans = 0;
  fullNodes = 0;
  revisions = 0;
  opens = 0;
  closes = 0;
  live = 0;
  peak = 0;
  closeGate?: Promise<void>;
  readonly limits: number[] = [];
  readonly reads: Array<{ method: string; id: string; after?: string | null }> = [];

  /**
   * 仅用于建立/修改测试数据，仍走正式内存事务端口。
   * @param treeId 测试树 ID
   * @param mode 创建或已有树事务
   * @param work fixture 写入
   */
  transact<T>(treeId: string, mode: 'existing' | 'createNew', work: (tx: WriteTransaction) => T | Promise<T>): Promise<T> {
    return this.memory.transact(treeId, mode, work);
  }

  /**
   * 包装正式快照；所有列表用实际返回行数、空查至少一次计费。
   * @param treeId 所选树 ID
   */
  async openRead(treeId: string): Promise<ReadSnapshot> {
    this.opens++;
    const snapshot = await this.memory.openRead(treeId);
    this.live++; this.peak = Math.max(this.peak, this.live);
    return {
      stamp: snapshot.stamp, rootId: snapshot.rootId,
      readNode: async (id) => { this.fullNodes++; return snapshot.readNode(id); },
      readNodeRow: async (id) => {
        this.scans++; this.reads.push({ method: 'row', id });
        return snapshot.readNodeRow(id);
      },
      readRevision: async (id) => { this.revisions++; return snapshot.readRevision(id); },
      listChildren: async (id, after, limit) => {
        this.limits.push(limit); this.reads.push({ method: 'children', id, after });
        const rows = await snapshot.listChildren(id, after, limit);
        this.scans += Math.max(1, rows.length); return rows;
      },
      listRefsFrom: async (id, after, limit) => {
        this.limits.push(limit); this.reads.push({ method: 'out', id, after });
        const rows = await snapshot.listRefsFrom(id, after, limit);
        this.scans += Math.max(1, rows.length); return rows;
      },
      listRefsTo: async (id, after, limit) => {
        this.limits.push(limit); this.reads.push({ method: 'in', id, after });
        const rows = await snapshot.listRefsTo(id, after, limit);
        this.scans += Math.max(1, rows.length); return rows;
      },
      listRevisions: snapshot.listRevisions.bind(snapshot),
      listUnconfirmed: snapshot.listUnconfirmed.bind(snapshot),
      close: async () => {
        await this.closeGate; await snapshot.close(); this.live--; this.closes++;
      },
    };
  }
}

/**
 * 直接建立测试 fixture，不把此写法冒充正式业务写入口。
 * @param nodes 测试节点
 * @param refs 测试引用
 */
async function fixture(nodes: CognitionNode[], refs: Ref[] = []): Promise<{ store: MeasuredStore; queries: Queries }> {
  const store = new MeasuredStore();
  await store.transact('T', 'createNew', (tx) => {
    for (const row of nodes) tx.writeNode(row);
    for (const edge of refs) tx.writeRef(edge);
  });
  return { store, queries: createQueries(store) };
}

/** 接口单 3.2 的原树，B 的其它孩子和 Y 的后继用来检查误展开。 */
async function example(): Promise<{ store: MeasuredStore; queries: Queries }> {
  return fixture([
    node('R', null), node('A', 'R'), { ...node('C', 'A'), origin: { kind: 'erratum' } },
    node('B', 'R'), node('Y', 'B'), node('X', 'B'), node('Z', 'R'), node('Y1', 'Y'), node('Z1', 'Z'),
  ], [ref('cy', 'C', 'Y'), ref('yz', 'Y', 'Z')]);
}

/**
 * 核对每页独立连通，引用仍是旁边的关联，没有变成第二父节点。
 * @param view 正式查询结果
 */
function connected(view: TreeView): void {
  const nodes = new Map(view.nodes.map((row) => [row.id, row]));
  expect(nodes.size).toBe(view.nodes.length);
  expect(nodes.has(view.rootId)).toBe(true);
  expect(nodes.has(view.focusId)).toBe(true);
  for (const row of nodes.values()) {
    if (row.id === view.rootId) expect(row.parentId).toBeNull();
    else expect(nodes.has(row.parentId!)).toBe(true);
  }
  for (const edge of view.refs) {
    expect(nodes.has(edge.from)).toBe(true);
    if (edge.target.nodeId !== undefined) expect(nodes.has(edge.target.nodeId)).toBe(true);
  }
}

/**
 * 提取本页实际命中，不混入连接祖先。
 * @param view 正式查询结果
 */
function hitIds(view: TreeView): string[] { return view.nodes.filter((row) => row.role === 'hit').map((row) => row.id).sort(); }

/**
 * 有限轮内取尽分页；每页都检查实际扫描、节点和 UTF-8 JSON 大小。
 * @param queries 同一查询实例
 * @param store 测量端口调用的存储
 * @param focus 显式起点
 * @param expand 显式请求范围
 * @param budget 每页固定的预算
 * @param omitZeroHopRefScope 是否走 AI 零跳数投影
 */
async function collect(queries: Queries, store: MeasuredStore, focus: Focus, expand: Expand, budget: Budget, omitZeroHopRefScope = false): Promise<TreeView[]> {
  const pages: TreeView[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 10_000; round++) {
    const before = store.scans;
    const view = await queries.readView('T', focus, expand, budget, 'fold', cursor, omitZeroHopRefScope);
    expect(store.scans - before).toBeLessThanOrEqual(budget.maxScans);
    expect(view.nodes.length).toBeLessThanOrEqual(budget.maxNodes);
    expect(new TextEncoder().encode(JSON.stringify(view)).byteLength).toBeLessThanOrEqual(budget.maxBytes);
    connected(view); pages.push(view);
    if (view.complete) { expect(view.cursor).toBeUndefined(); return pages; }
    expect(view.cursor).toBeDefined();
    expect(view.cursor!.length).toBeLessThan(40);
    expect(view.boundaries.some((boundary) => boundary.kind === 'budget')).toBe(true);
    cursor = view.cursor;
  }
  throw new Error('查询没有在有限轮内耗尽，可能返回了空转游标');
}

afterEach(() => { vi.restoreAllMocks(); });

describe('readView：随页读取完整节点详情', () => {
  it('命中和引用补入的父链节点都与点查一致；缺省/false 不读正文或修订', async () => {
    const { queries, store } = await example();
    const model = createWriteModel(store, { now: () => '2026-11-24T00:00:00Z' });
    await model.decideNode('ai', 'T', 'B', { type: 'prune', reason: '反例成立', reviveWhen: '有反证' });
    const expand = { ...baseExpand, subtreeDepth: 1, jumpHops: 1 };
    const light = await queries.readView('T', 'A', expand, large, 'exact', undefined, true);
    expect(await queries.readView('T', 'A', expand, large, 'exact', undefined, true, false)).toEqual(light);
    expect(light.nodes.every((row) => !('detail' in row))).toBe(true);
    expect(store.fullNodes).toBe(0); expect(store.revisions).toBe(0);

    const detailed = await queries.readView('T', 'A', expand, large, 'exact', undefined, true, true);
    connected(detailed);
    expect({ ...detailed, nodes: detailed.nodes.map(({ detail: _detail, ...row }) => row) }).toEqual(light);
    expect(store.fullNodes).toBe(5); expect(store.revisions).toBe(1);
    for (const row of detailed.nodes) expect(row.detail).toEqual(await queries.readNode('T', row.id));
    expect(detailed.nodes.find((row) => row.id === 'B')).toMatchObject({ role: 'link', detail: {
      node: { state: 'prune', pruneReason: '反例成立', reviveWhen: '有反证' },
      currentChange: { kind: 'formation', by: 'ai', detail: { action: 'prune', reason: '反例成立' } },
    } });
    expect(detailed.nodes.find((row) => row.id === 'R')?.detail).not.toHaveProperty('currentChange');
  });

  it('扫描上限包含详情和当前形成记录；预算不足时不执行下一笔查找', async () => {
    const { queries, store } = await example();
    const model = createWriteModel(store, { now: () => '2026-11-24T00:00:00Z' });
    await model.decideNode('ai', 'T', 'B', { type: 'setOpenOrKeep', state: 'keep', reason: '理由' });
    await expect(queries.readView('T', 'B', baseExpand, { ...large, maxScans: 3 }, 'exact', undefined, true, true))
      .rejects.toMatchObject({ code: 'rangeTooLarge', message: expect.stringContaining('maxScans') });
    expect(store.scans + store.fullNodes + store.revisions).toBe(3);
    expect(store.revisions).toBe(0);
    expect(store.live).toBe(0);
    const view = await queries.readView('T', 'B', baseExpand, { ...large, maxScans: 5 }, 'exact', undefined, true, true);
    expect(view.complete).toBe(true);
    expect(store.scans + store.fullNodes + store.revisions).toBe(8);
    expect(store.revisions).toBe(1);
    expect(store.reads.every(({ method }) => method !== 'in' && method !== 'out')).toBe(true);
    await expect(queries.readView('T', 'B', baseExpand, large, 'exact', undefined, true, 'true' as never))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(store.opens).toBe(2);
  });

  it('以实际 UTF-8 JSON 计费；续读完整节点、保持原快照并拒绝切换详情模式', async () => {
    const text = '中文😀\\\n"'.repeat(260);
    const { queries, store } = await fixture([
      node('R', null),
      { ...node('A', 'R'), body: { title: 'A', text, basis: '依据' } },
      { ...node('B', 'R'), body: { title: 'B', text, source: '出处' } },
    ]);
    const model = createWriteModel(store, { now: () => '2026-11-24T00:00:00Z' });
    await model.decideNode('ai', 'T', 'B', { type: 'setOpenOrKeep', state: 'keep', reason: '初始结论' });
    const before = await queries.readNode('T', 'B');
    const expand = { ...baseExpand, subtreeDepth: 'leaf' as const };
    const full = await queries.readView('T', 'R', expand, large, 'exact', undefined, true, true);
    const size = new TextEncoder().encode(JSON.stringify(full)).byteLength;
    expect(await queries.readView('T', 'R', expand, { ...large, maxBytes: size }, 'exact', undefined, true, true)).toEqual(full);
    await expect(queries.readView('T', 'R', expand, { ...large, maxBytes: size - 1 }, 'exact', undefined, true, true))
      .rejects.toMatchObject({ code: 'rangeTooLarge', message: expect.stringContaining('maxBytes') });

    const budget = { ...large, maxBytes: size - 1_200 };
    const first = await queries.readView('T', 'R', expand, budget, 'fold', undefined, true, true);
    expect(first.complete).toBe(false);
    expect(first.nodes.find((row) => row.id === 'A')?.detail?.node.body.text).toBe(text);
    expect(first.nodes.some((row) => row.id === 'B')).toBe(false);
    await expect(queries.readView('T', 'R', expand, budget, 'fold', first.cursor, true, false))
      .rejects.toMatchObject({ code: 'invalid' });
    await model.decideNode('human', 'T', 'B', { type: 'prune', reason: '新的反例', reviveWhen: '补齐证据' });
    const second = await queries.readView('T', 'R', expand, budget, 'fold', first.cursor, true, true);
    expect(second.complete).toBe(true);
    expect(second.stamp).toBe(first.stamp);
    expect(second.nodes.find((row) => row.id === 'B')?.detail).toEqual(before);
    expect((await queries.readNode('T', 'B')).node.pruneReason).toBe('新的反例');
    for (const page of [first, second]) {
      connected(page);
      expect(page.nodes.every((row) => row.detail?.node.id === row.id)).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(budget.maxBytes);
    }
  });
});

describe('readView：接口单 3.2 的树形和展开语义', () => {
  it('补齐原父链，引用落点仍在 B 下，连接祖先不扩出其它分支', async () => {
    const { queries, store } = await example();
    const view = await queries.readView('T', 'A', { ...baseExpand, subtreeDepth: 1, jumpHops: 1 }, large, 'exact');
    connected(view);
    expect(view.nodes.map((row) => row.id).sort()).toEqual(['A', 'B', 'C', 'R', 'Y']);
    expect(hitIds(view)).toEqual(['A', 'C', 'Y']);
    expect(view.nodes.find((row) => row.id === 'Y')?.parentId).toBe('B');
    expect(view.nodes.find((row) => row.id === 'C')?.origin.kind).toBe('erratum');
    expect(view.refs).toEqual([ref('cy', 'C', 'Y')]);
    expect(store.fullNodes).toBe(0); expect(store.revisions).toBe(0);
    expect(store.opens).toBe(1); expect(store.closes).toBe(1);
  });

  it('anchor 只从本轮起点跳，不从初始子树的 C 跳', async () => {
    const { queries } = await example();
    const view = await queries.readView('T', 'A', { ...baseExpand, subtreeDepth: 1, jumpHops: 1, jumpFrom: 'anchor' }, large, 'exact');
    expect(hitIds(view)).toEqual(['A', 'C']); expect(view.refs).toEqual([]);
    expect(view.boundaries).toContainEqual({ nodeId: 'C', axis: 'refs', kind: 'scope' });
    expect(view.boundaries).toContainEqual({ nodeId: 'A', axis: 'refs', kind: 'exhausted' });
  });

  it('显式根与 leaf 读到叶子；零深度/零跳数只标 scope，不以未查询冒充查尽', async () => {
    const { queries } = await example();
    const zero = await queries.readView('T', 'A', baseExpand, large, 'exact');
    expect(hitIds(zero)).toEqual(['A']);
    expect(zero.boundaries).toEqual([
      { nodeId: 'A', axis: 'children', kind: 'scope' }, { nodeId: 'A', axis: 'refs', kind: 'scope' },
    ]);
    const all = await queries.readView('T', { root: true }, { ...baseExpand, subtreeDepth: 'leaf' }, large, 'exact');
    expect(all.focusId).toBe('R'); expect(all.nodes).toHaveLength(9); expect(all.complete).toBe(true);
    expect(all.boundaries).toContainEqual({ nodeId: 'C', axis: 'children', kind: 'exhausted' });
  });

  it('入向和双向仍保留引用原方向和类型', async () => {
    const { queries } = await example();
    const incoming = await queries.readView('T', 'Y', { ...baseExpand, jumpHops: 1, direction: 'in' }, large, 'exact');
    expect(hitIds(incoming)).toEqual(['C', 'Y']); expect(incoming.refs).toEqual([ref('cy', 'C', 'Y')]);
    connected(incoming);
    const both = await queries.readView('T', 'Y', { ...baseExpand, jumpHops: 1, direction: 'both' }, large, 'exact');
    expect(hitIds(both)).toEqual(['C', 'Y', 'Z']);
    expect(both.refs.map((edge) => edge.id).sort()).toEqual(['cy', 'yz']);
  });

  it('每次落点都用 afterJumpDepth，与初始深度和跳数独立', async () => {
    const { queries } = await example();
    const view = await queries.readView('T', 'C', { ...baseExpand, jumpHops: 2, afterJumpDepth: 1, jumpFrom: 'anchor' }, large, 'exact');
    expect(hitIds(view)).toEqual(['C', 'Y', 'Y1', 'Z', 'Z1']);
    expect(view.nodes.find((row) => row.id === 'A')?.role).toBe('link');
    expect(view.refs.map((edge) => edge.id)).toEqual(['cy', 'yz']);
  });

  it('外部引用只返回定位符；不展开成虚构节点', async () => {
    const external: Ref = { id: 'external', from: 'A', kind: 'conflict', target: { doc: '依据.md', part: '反例😀' } };
    const { queries } = await fixture([node('R', null), node('A', 'R')], [external]);
    const view = await queries.readView('T', 'A', { ...baseExpand, jumpHops: 1 }, large, 'exact');
    expect(view.nodes).toHaveLength(2); expect(view.refs).toEqual([external]); connected(view);
    expect(view.boundaries).toContainEqual({ nodeId: 'A', axis: 'refs', kind: 'exhausted' });
  });

  it('重边保留各自 ID，环不反复展开同一状态', async () => {
    const { queries, store } = await fixture([node('R', null), node('A', 'R'), node('B', 'R')], [
      ref('a', 'A', 'B'), { ...ref('b', 'A', 'B'), kind: 'premise' }, ref('c', 'B', 'A'), ref('d', 'A', 'A'),
    ]);
    const view = await queries.readView('T', 'A', { ...baseExpand, jumpHops: 1000, direction: 'both' }, large, 'exact');
    expect(view.nodes).toHaveLength(3); expect(view.refs).toHaveLength(4); connected(view);
    expect(store.scans).toBeLessThan(30);
  });

  it('较晚到达拥有更多剩余跳数时，补读首次到达没有覆盖的引用', async () => {
    const { queries } = await fixture([
      node('R', null), node('S', 'R'), node('C', 'S'), node('T', 'R'), node('Y', 'R'), node('Z', 'R'),
    ], [ref('ct', 'C', 'T'), ref('ty', 'T', 'Y'), ref('sy', 'S', 'Y'), ref('yz', 'Y', 'Z')]);
    const view = await queries.readView('T', 'S', { ...baseExpand, subtreeDepth: 1, jumpHops: 2 }, large, 'exact');
    expect(hitIds(view)).toEqual(['C', 'S', 'T', 'Y', 'Z']);
    expect(view.refs.map((edge) => edge.id).sort()).toEqual(['ct', 'sy', 'ty', 'yz']);
  });

  it('较晚到达拥有更多树深时，不以已经命中过为由漏掉孩子', async () => {
    const { queries } = await fixture([
      node('R', null), node('S', 'R'), node('C', 'S'), node('Y', 'S'), node('Y1', 'Y'),
    ], [ref('cy', 'C', 'Y')]);
    const view = await queries.readView('T', 'S', { ...baseExpand, subtreeDepth: 2, jumpHops: 1, afterJumpDepth: 0 }, large, 'exact');
    expect(hitIds(view)).toEqual(['C', 'S', 'Y', 'Y1']); expect(view.nodes).toHaveLength(5);
  });

  it('补入的连接祖先即使有出边，也不能自动成为起跳点', async () => {
    const { queries } = await fixture([
      node('R', null), node('A', 'R'), node('C', 'A'), node('B', 'R'), node('Y', 'B'), node('U', 'R'),
    ], [ref('cy', 'C', 'Y'), ref('bu', 'B', 'U')]);
    const view = await queries.readView('T', 'C', { ...baseExpand, jumpHops: 3 }, large, 'exact');
    expect(hitIds(view)).toEqual(['C', 'Y']); expect(view.nodes.some((row) => row.id === 'U')).toBe(false);
  });
});

describe('readView：AI 零跳数投影', () => {
  it('只省略引用范围标记，在分页计费前省下字节；焦点和真实祖先不变', async () => {
    const { queries, store } = await fixture([node('R', null), node('A', 'R'), node('C', 'A', '有引号"和中文😀')], [ref('ca', 'C', 'A')]);
    const full = await queries.readView('T', 'C', baseExpand, large, 'exact');
    const expected = { ...full, boundaries: full.boundaries.filter((b) => b.axis !== 'refs') };
    const bytes = new TextEncoder().encode(JSON.stringify(expected)).byteLength;
    const budget = { ...large, maxBytes: bytes };
    expect(full.boundaries).toContainEqual({ nodeId: 'C', axis: 'refs', kind: 'scope' });
    await expect(queries.readView('T', 'C', baseExpand, budget, 'exact')).rejects.toMatchObject({ code: 'rangeTooLarge' });
    const compact = await queries.readView('T', 'C', baseExpand, budget, 'fold', undefined, true);
    expect(compact).toEqual(expected);
    connected(compact);
    expect(hitIds(compact)).toEqual(['C']);
    expect(store.reads.every(({ method }) => method === 'row')).toBe(true);
  });

  it('折叠位置仍在子节点轴，续读可取尽命中；有引用跳数时保留原始边和边界', async () => {
    const { queries, store } = await example();
    const expand = { ...baseExpand, subtreeDepth: 1 };
    const pages = await collect(queries, store, 'R', expand, { maxScans: 2, maxNodes: 3, maxBytes: 850 }, true);
    expect(pages.length).toBeGreaterThan(1);
    expect([...new Set(pages.flatMap(hitIds))].sort()).toEqual(['A', 'B', 'R', 'Z']);
    expect(pages.flatMap((view) => view.boundaries).every((b) => b.axis === 'children')).toBe(true);
    expect(pages.at(-1)?.boundaries).toContainEqual({ nodeId: 'R', axis: 'children', kind: 'exhausted' });
    const withRefs: Expand = { ...baseExpand, direction: 'in', jumpHops: 1 };
    const full = await queries.readView('T', 'Y', withRefs, large, 'exact');
    const compact = await queries.readView('T', 'Y', withRefs, large, 'exact', undefined, true);
    expect(compact).toEqual(full);
    expect(compact.refs).toEqual([ref('cy', 'C', 'Y')]);
  });

  it('零跳数续读不能混用投影，但可以换预算；最后一个查尽标记不预留游标', async () => {
    const { queries } = await fixture([node('R', null), node('A', 'R')]);
    const expand = { ...baseExpand, subtreeDepth: 1 };
    const first = await queries.readView('T', 'R', expand, { ...large, maxScans: 1 }, 'fold', undefined, true);
    expect(first.cursor).toBeDefined();
    await expect(queries.readView('T', 'R', expand, large, 'fold', first.cursor)).rejects.toMatchObject({ code: 'invalid' });
    const next = await queries.readView('T', 'R', expand, large, 'fold', first.cursor, true);
    expect(next.complete).toBe(true);
    expect(hitIds(next)).toEqual(['A', 'R']);
    const leaf = await queries.readView('T', 'A', expand, large, 'exact', undefined, true);
    const bytes = new TextEncoder().encode(JSON.stringify(leaf)).byteLength;
    expect(await queries.readView('T', 'A', expand, { ...large, maxBytes: bytes }, 'fold', undefined, true)).toEqual(leaf);
  });
});

describe('readView：宿主模型表示计费', () => {
  /** 模拟一个只输出标题和明确边界的小宿主格式，测试内核能否用它替代 JSON 成本。@param view 候选或最终页。 */
  function modelBytes(view: TreeView): number {
    return new TextEncoder().encode([
      ...view.nodes.map((n) => n.title),
      ...view.boundaries.map((b) => `${b.nodeId}:${b.axis}:${b.kind}`),
      view.cursor ?? '',
    ].join('\n')).byteLength;
  }

  it('AI 按已注入的 UTF-8 临界值放行，人工 JSON 入口不套用模型度量', async () => {
    const { store } = await fixture([node('R', null, '中文与😀')]);
    const cost = { canMeasure: vi.fn(() => true), measure: vi.fn(modelBytes) };
    const queries = createQueries(store, cost);
    const view = await queries.readView('T', 'R', baseExpand, large, 'exact', undefined, true);
    const size = modelBytes(view);
    expect(new TextEncoder().encode(JSON.stringify(view)).byteLength).toBeGreaterThan(size);
    expect(await queries.readView('T', 'R', baseExpand, { ...large, maxBytes: size }, 'exact', undefined, true)).toEqual(view);
    await expect(queries.readView('T', 'R', baseExpand, { ...large, maxBytes: size - 1 }, 'exact', undefined, true)).rejects.toMatchObject({
      code: 'rangeTooLarge', message: '读取超出 maxBytes。请增加对应预算或缩小范围。',
    });
    cost.measure.mockClear();
    await expect(queries.readView('T', 'R', baseExpand, { ...large, maxBytes: size }, 'exact')).rejects.toMatchObject({ code: 'rangeTooLarge' });
    expect(cost.measure).not.toHaveBeenCalled();
  });

  it('宽页和度量拒绝时按 canonical JSON 预算；宽页不构造模型候选', async () => {
    const { store, queries: legacy } = await fixture([node('R', null), node('A', 'R'), node('B', 'R')]);
    const expand = { ...baseExpand, subtreeDepth: 1 };
    const expected = await legacy.readView('T', 'R', expand, large, 'exact', undefined, true);
    const size = new TextEncoder().encode(JSON.stringify(expected)).byteLength;
    const measure = vi.fn((_view: TreeView) => undefined);
    const queries = createQueries(store, { canMeasure: (nodes) => nodes < 3, measure });
    expect(await queries.readView('T', 'R', expand, { ...large, maxBytes: size }, 'exact', undefined, true)).toEqual(expected);
    expect(measure).toHaveBeenCalled();
    expect(measure.mock.calls.every(([page]) => page.nodes.length < 3)).toBe(true);
    await expect(queries.readView('T', 'R', expand, { ...large, maxBytes: size - 1 }, 'exact', undefined, true)).rejects.toMatchObject({ code: 'rangeTooLarge' });
  });

  it('模型度量包括预算边界与实际游标，非零跳数的页也不和人侧混续', async () => {
    const { store } = await fixture([node('R', null), node('A', 'R')]);
    const measure = vi.fn(modelBytes);
    const queries = createQueries(store, { canMeasure: () => true, measure });
    const expand = { ...baseExpand, subtreeDepth: 1, jumpHops: 1 };
    const first = await queries.readView('T', 'R', expand, { ...large, maxScans: 1 }, 'fold', undefined, true);
    expect(first.complete).toBe(false);
    expect(first.cursor).toBeTruthy();
    expect(first.boundaries.some((b) => b.kind === 'budget')).toBe(true);
    expect(measure).toHaveBeenLastCalledWith(first);
    await expect(queries.readView('T', 'R', expand, large, 'fold', first.cursor)).rejects.toMatchObject({ code: 'invalid' });
    const later = await queries.readView('T', 'R', expand, large, 'fold', first.cursor, true);
    expect(later.complete).toBe(true);
    expect(later.stamp).toBe(first.stamp);
    expect(hitIds(later)).toEqual(['A', 'R']);
  });
});

describe('readView：实际扫描、节点和 UTF-8 输出预算', () => {
  it('空查与双向探测也计费，扫描额度用尽之前不多发一次查询', async () => {
    const { store, queries } = await fixture([node('R', null)]);
    const expand: Expand = { ...baseExpand, subtreeDepth: 'leaf', jumpHops: 1, direction: 'both' };
    const view = await queries.readView('T', 'R', expand, { ...large, maxScans: 4 }, 'exact');
    expect(view.complete).toBe(true); expect(store.scans).toBe(4);
    const before = store.scans;
    await expect(queries.readView('T', 'R', expand, { ...large, maxScans: 3 }, 'exact')).rejects.toMatchObject({
      code: 'rangeTooLarge', message: expect.stringContaining('读取超出 maxScans。'),
    });
    expect(store.scans - before).toBe(3);
  });

  it('长父链同时计入扫描、节点和字节；装不下时不返回断树', async () => {
    const rows = [node('R', null), ...Array.from({ length: 12 }, (_, index) => node(`N${index}`, index === 0 ? 'R' : `N${index - 1}`))];
    const { store, queries } = await fixture(rows);
    await expect(queries.readView('T', 'N11', baseExpand, { ...large, maxScans: 12 }, 'fold')).rejects.toMatchObject({ code: 'rangeTooLarge' });
    expect(store.scans).toBe(12);
    await expect(queries.readView('T', 'N11', baseExpand, { ...large, maxNodes: 12 }, 'fold')).rejects.toMatchObject({
      code: 'rangeTooLarge', message: expect.stringContaining('读取超出 maxNodes。'),
    });
    const beforeOutputLimit = store.scans;
    await expect(queries.readView('T', 'N11', baseExpand, { ...large, maxNodes: 12, maxBytes: 500 }, 'fold')).rejects.toMatchObject({
      code: 'rangeTooLarge', message: expect.stringMatching(/maxNodes、maxBytes。已知 maxBytes 至少需要 \d+ 字节（UTF-8）/),
    });
    expect(store.scans - beforeOutputLimit).toBe(13); // 只读取了不可省的父链。
    const view = await queries.readView('T', 'N11', baseExpand, { ...large, maxScans: 13, maxNodes: 13 }, 'fold');
    expect(view.nodes).toHaveLength(13); connected(view);
  });

  it('按实际 UTF-8 JSON 的精确字节边界，而不是 JS 字符数，接受正好容得下的响应', async () => {
    const { queries } = await fixture([node('R', null, '中文😀\ud800"\\\n')]);
    const expected = await queries.readView('T', 'R', baseExpand, large, 'exact');
    const bytes = new TextEncoder().encode(JSON.stringify(expected)).byteLength;
    expect(bytes).toBeGreaterThan(JSON.stringify(expected).length);
    expect(await queries.readView('T', 'R', baseExpand, { ...large, maxBytes: bytes }, 'exact')).toEqual(expected);
    expect(await queries.readView('T', 'R', baseExpand, { ...large, maxBytes: bytes }, 'fold')).toEqual(expected);
    await expect(queries.readView('T', 'R', baseExpand, { ...large, maxBytes: bytes - 1 }, 'exact')).rejects.toMatchObject({
      code: 'rangeTooLarge', message: expect.stringContaining(`maxBytes 至少需要 ${bytes} 字节（UTF-8）`),
    });
  });

  it('只能装下裸焦点却装不下折叠标记时，指出字节上限而不把游标成本冒充最低需求', async () => {
    const { queries } = await fixture([node('R', null), node('A', 'R')]);
    const full = await queries.readView('T', 'R', baseExpand, large, 'exact', undefined, true);
    const bareBytes = new TextEncoder().encode(JSON.stringify({ ...full, boundaries: [] })).byteLength;
    await expect(queries.readView('T', 'R', { ...baseExpand, subtreeDepth: 1 }, { ...large, maxBytes: bareBytes }, 'fold', undefined, true)).rejects.toMatchObject({
      code: 'rangeTooLarge', message: '读取超出 maxBytes。请增加对应预算或缩小范围。',
    });
  });

  it('5 MB 以上正文与高扇出不被加载，低预算只向索引要有界单行', async () => {
    const rows = [node('R', null), ...Array.from({ length: 5000 }, (_, index) => ({
      ...node(`N${index.toString().padStart(5, '0')}`, 'R'), body: { title: '判断😀', text: '内'.repeat(400) },
    }))];
    expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeGreaterThan(5_000_000);
    const { queries, store } = await fixture(rows);
    const view = await queries.readView('T', 'R', { ...baseExpand, subtreeDepth: 1 }, { ...large, maxScans: 7, maxNodes: 5 }, 'fold');
    connected(view); expect(view.complete).toBe(false); expect(view.nodes).toHaveLength(5);
    expect(store.scans).toBeLessThanOrEqual(7); expect(store.fullNodes).toBe(0);
    expect(new Set(store.limits)).toEqual(new Set([1]));
    expect(view.boundaries.some((boundary) => boundary.kind === 'budget')).toBe(true);
  });

  it('高入度/重复命中仍按实际邻接扫描推进，不先全量取引用再去重', async () => {
    const edges = Array.from({ length: 1000 }, (_, index) => ref(`E${index.toString().padStart(5, '0')}`, 'A', 'Y'));
    const { queries, store } = await fixture([node('R', null), node('A', 'R'), node('Y', 'R')], edges);
    const pages = await collect(queries, store, 'Y', { ...baseExpand, jumpHops: 1, direction: 'in' }, { maxScans: 17, maxNodes: 3, maxBytes: 2500 });
    expect(pages.length).toBeGreaterThan(50);
    expect(new Set(pages.flatMap((view) => view.refs.map((edge) => edge.id))).size).toBe(1000);
    expect(store.scans).toBeLessThan(1300); expect(store.fullNodes).toBe(0);
    expect(new Set(store.limits)).toEqual(new Set([1]));
  });

  it('节点预算跨页正向推进直到耗尽；每页都有根和焦点，累计完成不代表单页全树', async () => {
    const { queries, store } = await fixture([node('R', null), ...Array.from({ length: 31 }, (_, index) => node(`N${index.toString().padStart(3, '0')}`, 'R'))]);
    const pages = await collect(queries, store, 'R', { ...baseExpand, subtreeDepth: 1 }, { maxScans: 6, maxNodes: 4, maxBytes: 2000 });
    expect(pages.length).toBeGreaterThan(5); expect(pages[pages.length - 1].nodes.length).toBeLessThan(32);
    expect(new Set(pages.flatMap((view) => hitIds(view))).size).toBe(32);
    expect(pages[pages.length - 1].boundaries).toContainEqual({ nodeId: 'R', axis: 'children', kind: 'exhausted' });
    expect(store.opens).toBe(1); expect(store.closes).toBe(1);
  });

  it('字节预算把引用和折叠标记一起计费，续读能取尽中文长标题', async () => {
    const { queries, store } = await fixture([
      node('R', null), ...Array.from({ length: 20 }, (_, index) => node(`N${index.toString().padStart(3, '0')}`, 'R', '判断😀'.repeat(8))),
    ]);
    const pages = await collect(queries, store, 'R', { ...baseExpand, subtreeDepth: 1 }, { maxScans: 100, maxNodes: 100, maxBytes: 1400 });
    expect(pages.length).toBeGreaterThan(3); expect(new Set(pages.flatMap((view) => hitIds(view))).size).toBe(21);
  });

  it('exact 超限明确失败并关闭快照，不以部分结果报成功', async () => {
    const { queries, store } = await example();
    await expect(queries.readView('T', 'A', { ...baseExpand, subtreeDepth: 1, jumpHops: 1 }, { ...large, maxNodes: 4 }, 'exact')).rejects.toMatchObject({ code: 'rangeTooLarge' });
    expect(store.closes).toBe(1);
  });

  it('后续一项也无法推进时显式失败，不发反复空转的游标', async () => {
    const { queries, store } = await fixture([node('R', null), node('N', 'R')]);
    const expand: Expand = { ...baseExpand, subtreeDepth: 1 };
    const tiny = { ...large, maxNodes: 1 };
    const first = await queries.readView('T', 'R', expand, tiny, 'fold');
    expect(first.complete).toBe(false);
    await expect(queries.readView('T', 'R', expand, tiny, 'fold', first.cursor)).rejects.toMatchObject({ code: 'rangeTooLarge' });
    expect(store.closes).toBe(1);
    await expect(queries.readView('T', 'R', expand, large, 'fold', first.cursor)).rejects.toMatchObject({ code: 'viewExpired' });
  });
});

describe('readView：同版本续读、失效和有界生命周期', () => {
  it('页间提交新节点/状态不混入旧快照，新查询才看到新 stamp', async () => {
    const { store, queries } = await fixture([node('R', null), ...Array.from({ length: 10 }, (_, index) => node(`N${index}`, 'R'))]);
    const expand: Expand = { ...baseExpand, subtreeDepth: 1 };
    const budget = { ...large, maxScans: 3 };
    const first = await queries.readView('T', 'R', expand, budget, 'fold');
    await store.transact('T', 'existing', async (tx) => {
      tx.writeNode(node('NEW', 'R'));
      const previous = await tx.readNode('N9'); tx.writeNode({ ...previous!, state: 'keep' });
    });
    const pages = [first];
    while (!pages[pages.length - 1].complete) {
      pages.push(await queries.readView('T', 'R', expand, budget, 'fold', pages[pages.length - 1].cursor));
      expect(pages.length).toBeLessThan(20);
    }
    expect(new Set(pages.map((view) => view.stamp))).toEqual(new Set([first.stamp]));
    expect(pages.flatMap((view) => view.nodes).some((row) => row.id === 'NEW')).toBe(false);
    expect(pages.flatMap((view) => view.nodes).find((row) => row.id === 'N9')?.state).toBe('open');
    expect(store.opens).toBe(1);
    const fresh = await queries.readView('T', 'R', expand, large, 'exact');
    expect(fresh.stamp).toBe(first.stamp + 1); expect(hitIds(fresh)).toContain('NEW');
  });

  it('按树失效旧可见范围，释放快照且不影响其它树的游标', async () => {
    const { store, queries } = await fixture([node('R', null), node('A', 'R')]);
    await store.transact('other', 'createNew', tx => {
      tx.writeNode(node('Q', null));
      tx.writeNode(node('B', 'Q'));
    });
    const expand: Expand = { ...baseExpand, subtreeDepth: 1 };
    const small = { ...large, maxScans: 1 };
    const first = await queries.readView('T', 'R', expand, small, 'fold');
    const other = await queries.readView('other', 'Q', expand, small, 'fold');
    expect(first.cursor).toBeDefined();
    expect(other.cursor).toBeDefined();

    await queries.invalidateViews('T');

    expect(store.closes).toBe(1);
    await expect(queries.readView('T', 'R', expand, large, 'fold', first.cursor)).rejects.toMatchObject({ code: 'viewExpired' });
    await expect(queries.readView('other', 'Q', expand, large, 'fold', other.cursor)).resolves.toMatchObject({ complete: true });
    expect(store.opens).toBe(store.closes);
  });

  it('绑定查询范围、单次消费和实例；续读预算可改变', async () => {
    const { store, queries } = await example();
    const expand: Expand = { ...baseExpand, subtreeDepth: 1, jumpHops: 1 };
    const first = await queries.readView('T', 'A', expand, { ...large, maxScans: 3 }, 'fold');
    await expect(queries.readView('T', 'C', expand, large, 'fold', first.cursor)).rejects.toMatchObject({ code: 'invalid' });
    await expect(createQueries(store).readView('T', 'A', expand, large, 'fold', first.cursor)).rejects.toMatchObject({ code: 'viewExpired' });
    const last = await queries.readView('T', 'A', expand, large, 'fold', first.cursor);
    expect(last.complete).toBe(true);
    await expect(queries.readView('T', 'A', expand, large, 'fold', first.cursor)).rejects.toMatchObject({ code: 'viewExpired' });
    await expect(queries.readView('T', 'A', expand, large, 'fold', 'unknown')).rejects.toMatchObject({ code: 'viewExpired' });
  });

  it('绝对 TTL 不随续读延长，任一查询入口惰性清理过期快照', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { store, queries } = await fixture([node('R', null), ...Array.from({ length: 30 }, (_, index) => node(`N${index}`, 'R'))]);
    const expand: Expand = { ...baseExpand, subtreeDepth: 1 };
    const first = await queries.readView('T', 'R', expand, { ...large, maxScans: 2 }, 'fold');
    clock.mockReturnValue(60_000);
    const second = await queries.readView('T', 'R', expand, { ...large, maxScans: 2 }, 'fold', first.cursor);
    clock.mockReturnValue(61_001);
    await queries.readNode('T', 'R');
    expect(store.closes).toBe(2); // 旧视图与点查各关闭一次。
    await expect(queries.readView('T', 'R', expand, large, 'fold', second.cursor)).rejects.toMatchObject({ code: 'viewExpired' });
  });

  it('最多保留八个视图，容量驱逐最早闲置快照并令旧游标显式失效', async () => {
    const { store, queries } = await fixture([node('R', null), node('A', 'R')]);
    const expand: Expand = { ...baseExpand, subtreeDepth: 1 };
    const pages = [];
    for (let index = 0; index < 9; index++) pages.push(await queries.readView('T', 'R', expand, { ...large, maxScans: 1 }, 'fold'));
    expect(store.opens - store.closes).toBe(8);
    await expect(queries.readView('T', 'R', expand, large, 'fold', pages[0].cursor)).rejects.toMatchObject({ code: 'viewExpired' });
    for (const page of pages.slice(1)) expect((await queries.readView('T', 'R', expand, large, 'fold', page.cursor)).complete).toBe(true);
    expect(store.opens).toBe(store.closes);
  });

  it('自然序 N9/N10 与 E9/E10 的分页推进和存储比较器一致', async () => {
    const children = Array.from({ length: 20 }, (_, index) => node(`N${index}`, 'R'));
    const edges = Array.from({ length: 20 }, (_, index) => ref(`E${index}`, 'N0', 'N1'));
    const { queries } = await fixture([node('R', null), ...children], edges);
    const tree = await queries.readView('T', 'R', { ...baseExpand, subtreeDepth: 1 }, large, 'exact');
    expect(tree.nodes.filter((row) => row.id !== 'R').map((row) => row.id)).toEqual(children.map((row) => row.id));
    const related = await queries.readView('T', 'N0', { ...baseExpand, jumpHops: 1 }, large, 'exact');
    expect(related.refs.map((edge) => edge.id)).toEqual(edges.map((edge) => edge.id));
  });

  it('调用方改动已返回的一页，不会篡改内部快照/任务供后续页使用的对象', async () => {
    const { queries } = await fixture([node('R', null), node('A', 'R'), node('C', 'A')]);
    const expand: Expand = { ...baseExpand, subtreeDepth: 'leaf' };
    const first = await queries.readView('T', 'R', expand, { ...large, maxScans: 2 }, 'fold');
    const a = first.nodes.find((row) => row.id === 'A')!;
    a.title = '篡改'; a.origin.kind = 'erratum';
    first.nodes.find((row) => row.id === 'R')!.origin.kind = 'supplement';
    const next = await queries.readView('T', 'R', expand, large, 'fold', first.cursor);
    expect(next.nodes.find((row) => row.id === 'A')).toMatchObject({ title: 'A', origin: { kind: 'branch' } });
    expect(next.nodes.find((row) => row.id === 'R')?.origin.kind).toBe('branch');
  });

  it('异步调用开始时捕获已校验参数，调用方后改对象不能放宽预算或偷换范围', async () => {
    const { queries } = await fixture([node('R', null), node('A', 'R'), node('C', 'A')]);
    const expand: Expand = { ...baseExpand, subtreeDepth: 1 };
    const budget = { ...large, maxScans: 1 };
    const pending = queries.readView('T', 'R', expand, budget, 'fold');
    expand.subtreeDepth = 'leaf'; budget.maxScans = 1000;
    const first = await pending;
    expect(first.complete).toBe(false); expect(first.nodes).toHaveLength(1);
    const next = await queries.readView('T', 'R', { ...baseExpand, subtreeDepth: 1 }, large, 'fold', first.cursor);
    expect(hitIds(next)).toEqual(['A', 'R']);
  });

  it('并发驱逐时关闭中的快照也占位，实际存活峰值不超过八', async () => {
    const { queries, store } = await fixture([node('R', null), node('A', 'R')]);
    const expand: Expand = { ...baseExpand, subtreeDepth: 1 };
    for (let index = 0; index < 8; index++) await queries.readView('T', 'R', expand, { ...large, maxScans: 1 }, 'fold');
    let release!: () => void;
    store.closeGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = Promise.allSettled(Array.from({ length: 4 }, () => queries.readView('T', 'R', expand, { ...large, maxScans: 1 }, 'fold')));
    release();
    const results = await pending;
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(store.peak).toBeLessThanOrEqual(8); expect(store.live).toBeLessThanOrEqual(8);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    await queries.readNode('T', 'R');
    expect(store.live).toBe(0);
  });

  it('缺失目标与非法参数在正确边界失败，不打开无限/隐式读取', async () => {
    const { queries, store } = await example();
    await expect(queries.readView('T', 'missing', baseExpand, large, 'fold')).rejects.toMatchObject({ code: 'missing' });
    const opens = store.opens;
    const invalidBudgets = [{ ...large, maxScans: 0 }, { ...large, maxNodes: Infinity }, { ...large, maxBytes: NaN }];
    for (const budget of invalidBudgets) await expect(queries.readView('T', 'A', baseExpand, budget, 'fold')).rejects.toMatchObject({ code: 'invalid' });
    await expect(queries.readView('T', { root: false } as never, baseExpand, large, 'fold')).rejects.toMatchObject({ code: 'invalid' });
    await expect(queries.readView('T', 'A', { ...baseExpand, subtreeDepth: -1 }, large, 'fold')).rejects.toMatchObject({ code: 'invalid' });
    await expect(queries.readView('T', 'A', { ...baseExpand, jumpHops: 1.5 }, large, 'fold')).rejects.toMatchObject({ code: 'invalid' });
    expect(store.opens).toBe(opens);
  });
});
