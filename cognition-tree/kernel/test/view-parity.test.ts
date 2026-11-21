/**
 * 查询集成的独立判据：对一棵足够小、可以穷举的树，按「先展开一轮，再跳一次」直接求集合。
 * 它不复用正式遍历器或其队列/游标，用来检查环、多个落点、不同剩余深度的实现确实等价于接口单。
 * 只在测试中允许扫描小图；正式查询必须按索引与预算取数。
 */
import { expect, it } from 'vitest';
import { createQueries } from '../src/queries';
import { MemoryTreeStore } from '../src/storage/memory';
import type { Expand, Ref, TreeView } from '../src/types';

const parents: Record<string, string | null> = { R: null, A: 'R', C: 'A', D: 'C', B: 'R', Y: 'B', Z: 'Y' };
const edges: Ref[] = [
  ['e1', 'A', 'Y'], ['e2', 'C', 'B'], ['e3', 'Y', 'C'], ['e4', 'Z', 'A'], ['e5', 'C', 'Y'],
].map(([id, from, nodeId]) => ({ id, from, kind: 'example', target: { nodeId } }));
edges.push({ id: 'doc', from: 'Y', kind: 'example', target: { doc: '例子.md' } });

/**
 * 逐轮枚举命中节点及引用，再单独补父链；这里的连接节点永远不会反过来作为起跳点。
 * @param expand 本次要交叉核对的展开参数
 */
function expectedFor(expand: Expand) {
  const hits = new Set<string>(), refs = new Set<string>();
  let anchors = new Set(['A']);
  for (let hop = 0; hop <= expand.jumpHops; hop++) {
    const depth = hop === 0 ? expand.subtreeDepth : expand.afterJumpDepth;
    let level = anchors;
    const round = new Set(anchors);
    for (let d = 0; level.size && (depth === 'leaf' || d < depth); d++) {
      level = new Set(Object.keys(parents).filter(n => parents[n] !== null && level.has(parents[n]!)));
      for (const n of level) round.add(n);
    }
    for (const n of round) hits.add(n);
    if (hop === expand.jumpHops) break;
    const starts = expand.jumpFrom === 'anchor' ? anchors : round;
    anchors = new Set();
    for (const e of edges) {
      const target = e.target.nodeId;
      if (expand.direction !== 'in' && starts.has(e.from)) {
        refs.add(e.id);
        if (target !== undefined) anchors.add(target);
      }
      if (expand.direction !== 'out' && target !== undefined && starts.has(target)) {
        refs.add(e.id); anchors.add(e.from);
      }
    }
  }
  const connected = new Set(hits);
  for (const n of hits) for (let p = parents[n]; p !== null; p = parents[p]) connected.add(p);
  return { hits, refs, connected };
}

it('小图穷举：精确与分页的命中/连通节点/原方向边与直接展开一致', async () => {
  const store = new MemoryTreeStore();
  await store.transact('t', 'createNew', tx => {
    for (const [id, parentId] of Object.entries(parents)) tx.writeNode({ id, parentId, origin: { kind: 'branch' }, body: { title: id } });
    for (const edge of edges) tx.writeRef(edge);
  });
  const query = createQueries(store);
  const budget = { maxScans: 500, maxNodes: 100, maxBytes: 40000 };
  for (const subtreeDepth of [0, 1, 2]) for (const afterJumpDepth of [0, 1]) {
    for (const direction of ['in', 'out', 'both'] as const) for (const jumpFrom of ['anchor', 'expanded'] as const) {
      for (const jumpHops of [0, 1, 2, 3]) {
        const expand = { subtreeDepth, afterJumpDepth, direction, jumpFrom, jumpHops };
        const expected = expectedFor(expand);
        const whole = await query.readView('t', 'A', expand, budget, 'exact');
        expect(whole.complete).toBe(true);
        expect([...expected.hits].sort(), JSON.stringify(expand)).toEqual(whole.nodes.filter(n => n.role === 'hit').map(n => n.id).sort());
        expect(new Set(whole.nodes.map(n => n.id))).toEqual(expected.connected);
        expect(new Set(whole.refs.map(e => e.id))).toEqual(expected.refs);

        // 最困难的组合另用小预算逐页合并，避免大预算下的一次成功掩盖续读漏行。
        if (jumpHops === 3 && direction === 'both') {
          const found = new Set<string>(), references = new Set<string>();
          let cursor: string | undefined;
          let pages = 0;
          do {
            const view: TreeView = await query.readView('t', 'A', expand, { ...budget, maxScans: 12 }, 'fold', cursor);
            const ids = new Set(view.nodes.map(n => n.id));
            expect(ids.has('A') && ids.has('R')).toBe(true);
            for (const n of view.nodes) {
              expect(n.parentId === null || ids.has(n.parentId)).toBe(true);
              if (n.role === 'hit') found.add(n.id);
            }
            for (const e of view.refs) {
              expect(ids.has(e.from) && (e.target.nodeId === undefined || ids.has(e.target.nodeId))).toBe(true);
              references.add(e.id);
            }
            cursor = view.cursor;
            expect(++pages).toBeLessThan(100);
          } while (cursor);
          expect(found).toEqual(expected.hits); expect(references).toEqual(expected.refs);
        }
      }
    }
  }
});
