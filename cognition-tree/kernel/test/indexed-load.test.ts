/**
 * 本机内存集成负载，不是 SQLite 或浏览器性能测试。用大正文、分叉和定向入边让整树读取很昂贵；
 * 验证小提交只向持久化边界交出变化行，读操作按页工作，并把实测耗时留给复跑者而非设机器阈值。
 */
import { expect, it } from 'vitest';
import { createKernel } from '../src/catalog';
import { MemoryTreeStore } from '../src/storage/memory';
import type { ReadSnapshot, SeedTree, SeedNode, TreeStore } from '../src/types';
import { utf8ByteLength } from '../src/utils';

const treeId = 'load';
const fanout = 256;
const writes = 40;
const budget = { maxScans: 48, maxNodes: 8, maxBytes: 4096 };

/** 构造含长正文的已确认导入节点；长正文不能随轻行投影进入 readView。 */
function makeSeed(): SeedTree {
  const rootId = 'R';
  const nodes: SeedNode[] = [{ id: rootId, parentId: null, body: { title: '负载树' },
    origin: { kind: 'branch' }, confirmation: 'humanConfirmed' }];
  for (let i = 1; i <= fanout; i++) {
    nodes.push({ id: `N${i}`, parentId: rootId, body: { title: `判断 ${i}`, text: `${i}:${'依据'.repeat(3600)}` },
      origin: { kind: 'branch' }, state: 'open', confirmation: 'humanConfirmed' });
  }
  // 同一节点有大量入边。只读它的一个小页，不能把未访问的邻居正文带出来。
  const refs = nodes.slice(2).map(n => ({ id: `ref-${n.id}`, from: n.id, kind: 'example' as const, target: { nodeId: 'N1' } }));
  return { treeId, rootId, nodes, refs, history: [] };
}

/**
 * 在真实存储端口外记录调用方实际取到的行（含空查），而非用最后画出的节点数冒充扫描数。
 * @param store 真正持有版本与索引的存储，计量层不缓存也不排序数据
 */
function measure(store: TreeStore) {
  const count = { scans: 0, fullNodes: 0, pendingLimits: [] as number[] };
  /** 按带回的行计费，空的索引查找也有一次成本。@param rows 接口返回的一批邻接行 */
  function batch<T>(rows: T[]): T[] { count.scans += Math.max(1, rows.length); return rows; }
  const port: TreeStore = {
    transact: store.transact.bind(store),
    async openRead(id): Promise<ReadSnapshot> {
      const s = await store.openRead(id);
      return {
        stamp: s.stamp, rootId: s.rootId, close: () => s.close(),
        readNode: node => { count.fullNodes++; return s.readNode(node); },
        readNodeRow: node => { count.scans++; return s.readNodeRow(node); },
        listChildren: (...args) => s.listChildren(...args).then(batch),
        listRefsFrom: (...args) => s.listRefsFrom(...args).then(batch),
        listRefsTo: (...args) => s.listRefsTo(...args).then(batch),
        readRevision: rev => s.readRevision(rev), listRevisions: (...args) => s.listRevisions(...args),
        listUnconfirmed: (by, after, limit) => { count.pendingLimits.push(limit); return s.listUnconfirmed(by, after, limit); },
      };
    },
  };
  return { port, count };
}

it('5 MiB 以上的单树：伴随小修订读取有界子树、引用、历史和待确认索引', async () => {
  const seed = makeSeed();
  const seedBytes = utf8ByteLength(JSON.stringify(seed));
  expect(seedBytes).toBeGreaterThan(5 * 1024 * 1024);
  const changes: number[][] = [];
  const store = new MemoryTreeStore({ beforeCommit: (_id, mode, delta) => {
    if (mode === 'existing') changes.push([delta.nodes.length, delta.refs.length, delta.revisions.length]);
  } });
  let tick = 0;
  const { port, count } = measure(store);
  const kernel = createKernel({ store: port, clock: { now: () => new Date(Date.UTC(2026, 10, 20, 12, 0, tick++)).toISOString() } });
  await kernel.dispatch('human', 'bootstrapTree', { seed });
  const expand = { subtreeDepth: 0, jumpHops: 1, direction: 'in', jumpFrom: 'anchor', afterJumpDepth: 0 } as const;
  const readMs: number[] = [], writeMs: number[] = [];
  const usage = { maxMeasuredScans: 0, maxResponseBytes: 0 };
  const before = await store.openRead(treeId);
  try {
    for (let i = 1; i <= writes; i++) {
      const nodeId = `N${i}`;
      const start = performance.now();
      const scansBefore = count.scans;
      // 当写事务正在进行时发起局部读；各次读取独立一致，不要求二者共享版本。
      const writing = kernel.dispatch(i % 2 ? 'ai' : 'human', 'decideNode', {
        treeId, nodeId, decision: { type: 'setOpenOrKeep', state: 'keep', reason: `依据 ${i} 已核对` },
      }).then(() => writeMs.push(performance.now() - start));
      const reading = kernel.dispatch('human', 'readView', { treeId, focus: 'N1', expand, budget, onLimit: 'fold' })
        .then(view => {
          readMs.push(performance.now() - start);
          expect(view.complete).toBe(false);
          expect(view.nodes.length).toBeLessThanOrEqual(budget.maxNodes);
          const scans = count.scans - scansBefore;
          const responseBytes = utf8ByteLength(JSON.stringify(view));
          usage.maxMeasuredScans = Math.max(usage.maxMeasuredScans, scans);
          usage.maxResponseBytes = Math.max(usage.maxResponseBytes, responseBytes);
          expect(scans).toBeLessThanOrEqual(budget.maxScans);
          expect(responseBytes).toBeLessThanOrEqual(budget.maxBytes);
          expect(count.fullNodes).toBe(0);
          expect(view.nodes.some(n => n.id === seed.rootId)).toBe(true);
        });
      await Promise.all([writing, reading]);
    }
    expect((await before.readNodeRow('N1'))?.state).toBe('open');
    expect((await kernel.dispatch('human', 'readNode', { treeId, nodeId: 'N1' })).node.state).toBe('keep');
    expect(changes).toHaveLength(writes);
    expect(changes.every(([nodes, refs, revisions]) => nodes === 1 && refs === 0 && revisions === 1)).toBe(true);
    const history = await kernel.dispatch('ai', 'readHistory', { treeId, limit: 3 });
    expect(history.items.map(r => r.nodeIds[0])).toEqual(['N40', 'N39', 'N38']);
    const first = await kernel.dispatch('human', 'readUnconfirmed', { treeId, by: ['ai'], limit: 2 });
    expect(first.items.map(item => item.nodeIds?.[0])).toEqual(['N39', 'N37']);
    const second = await kernel.dispatch('human', 'readUnconfirmed', { treeId, by: ['ai'], limit: 2, after: first.next });
    expect(second.items.map(item => item.nodeIds?.[0])).toEqual(['N35', 'N33']);
    expect(count.pendingLimits).toEqual([3, 3]); // 每页两项、再探一项，无全量请求。
    console.info('内存实测', { seedBytes, fanout, inbound: seed.refs.length, writes, budget, usage,
      meanReadMs: meanMs(readMs), meanWriteMs: meanMs(writeMs), deltaRowsPerWrite: changes[0] });
  } finally { await before.close(); }
}, 30_000);

/** 只给本次运行的读写均值；不把调度噪声变成产品吞吐承诺。@param samples 操作发起到兑现的毫秒数 */
function meanMs(samples: number[]): number {
  return Number((samples.reduce((sum, n) => sum + n, 0) / samples.length).toFixed(2));
}
