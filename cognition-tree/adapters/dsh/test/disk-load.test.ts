/** 在真实隔离工作区透过正式内核修改两棵树；关掉全部连接，再仅从磁盘重开。不是浏览器/生产 DSH 实测。 */
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createKernel } from '@cognition-tree/kernel/catalog';
import type { SeedTree } from '@cognition-tree/kernel/types';
import { createT1Seed } from '../src/bootstrap';
import { SqliteTreeStore } from '../src/server/storage';

/** 每次复跑独立留样，只写仓库的 .local-work，不清理现有库。 */
function isolatedWorkspace(): string {
  const base = fileURLToPath(new URL('../../../../.local-work/dsh-disk-check/', import.meta.url));
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'run-'));
}

/** 生成高入度、大正文的已确认导入数据；读局部视图不应携带正文。 */
function largeSeed(): SeedTree {
  const seed: SeedTree = { treeId: 'Load', rootId: 'R', history: [], refs: [], nodes: [
    { id: 'R', parentId: null, body: { title: '负载树' }, origin: { kind: 'branch' } },
  ] };
  for (let i = 1; i <= 256; i++) {
    seed.nodes.push({ id: `N${i}`, parentId: 'R', origin: { kind: 'branch' }, confirmation: 'humanConfirmed', state: 'open',
      body: { title: `判断 ${i}`, text: `${i}：${'依据'.repeat(3600)}` } });
    if (i > 1) seed.refs.push({ id: `E${i}`, kind: 'example', from: `N${i}`, target: { nodeId: 'N1' } });
  }
  return seed;
}

it('同一工作区保留原 T1，一棵新的 AI 决策树不会复制或覆盖它，重开仍按 ID 隔离', async () => {
  const root = isolatedWorkspace();
  const clock = { now: () => '2026-11-20T12:00:00Z' };
  const oldStore = new SqliteTreeStore(root);
  const old = createT1Seed(); // 只为生成升级前的数据库；不经过 DSH 的任何入口。
  try { await createKernel({ store: oldStore, clock }).dispatch('human', 'bootstrapTree', { seed: old }); }
  finally { await oldStore.close(); }

  const newStore = new SqliteTreeStore(root);
  try {
    const k = createKernel({ store: newStore, clock });
    await expect(k.dispatch('ai', 'createTree', { treeId: 'T1', rootQuestion: '不得覆盖原树' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await k.dispatch('ai', 'createTree', { treeId: 'decisions', rootQuestion: '我们做过哪些取舍？' })).toBe('decisions');
  } finally { await newStore.close(); }

  const reopened = new SqliteTreeStore(root);
  try {
    const k = createKernel({ store: reopened, clock });
    const before = await k.dispatch('human', 'readNode', { treeId: 'T1', nodeId: old.rootId });
    expect(before.node.body).toEqual(old.nodes.find(n => n.id === old.rootId)!.body);
    const history = await k.dispatch('human', 'readHistory', { treeId: 'T1', limit: 50 });
    expect(history.items).toHaveLength(old.history.length);
    const created = await k.dispatch('human', 'readNode', { treeId: 'decisions', nodeId: 'decisions' });
    expect(created.node).toMatchObject({ parentId: null, body: { title: '我们做过哪些取舍？' }, confirmation: 'unconfirmed' });
    expect(created.currentChange).toMatchObject({ by: 'ai', detail: { action: 'createTree' } });
    await expect(k.dispatch('ai', 'readNode', { treeId: 'decisions', nodeId: old.rootId })).rejects.toMatchObject({ code: 'missing' });
  } finally { await reopened.close(); }
});

it('正式手稿和 5 MiB 负载分别落库；关闭重开后变更、确认与历史仍在', async () => {
  const root = isolatedWorkspace();
  const large = largeSeed();
  const seedBytes = Buffer.byteLength(JSON.stringify(large));
  expect(seedBytes).toBeGreaterThan(5 * 1024 * 1024);
  const expand = { subtreeDepth: 0, jumpHops: 1, direction: 'in', jumpFrom: 'anchor', afterJumpDepth: 0 } as const;
  const budget = { maxScans: 48, maxNodes: 8, maxBytes: 4096 };
  const clock = { now: () => new Date().toISOString() };
  const create = new SqliteTreeStore(root);
  let added = '', confirmation = '';
  let writeMs = 0, readMs = 0, maxViewBytes = 0;
  try {
    const k = createKernel({ store: create, clock });
    await k.dispatch('human', 'bootstrapTree', { seed: createT1Seed() });
    await k.dispatch('human', 'bootstrapTree', { seed: large });
    added = await k.dispatch('ai', 'addBranch', { treeId: 'T1', placement: { parentId: 'T1.2.4', kind: 'supplement' },
      draft: { state: 'open', body: { title: '仅在隔离库里增加的判断' }, refs: [] } });
    const detail = await k.dispatch('human', 'readNode', { treeId: 'T1', nodeId: added });
    confirmation = await k.dispatch('human', 'confirm', { treeId: 'T1', target: { revisionId: detail.currentChange!.id } });
    for (let i = 1; i <= 40; i++) {
      const start = performance.now();
      await k.dispatch(i % 2 ? 'ai' : 'human', 'decideNode', { treeId: 'Load', nodeId: `N${i}`,
        decision: { type: 'setOpenOrKeep', state: 'keep', reason: '依据已核对' } });
      const committed = performance.now();
      const page = await k.dispatch('human', 'readView', { treeId: 'Load', focus: 'N1', expand, budget, onLimit: 'fold' });
      readMs += performance.now() - committed; writeMs += committed - start;
      maxViewBytes = Math.max(maxViewBytes, Buffer.byteLength(JSON.stringify(page)));
      expect(page.complete).toBe(false);
      expect(page.nodes.length).toBeLessThanOrEqual(budget.maxNodes);
    }
    expect(maxViewBytes).toBeLessThanOrEqual(budget.maxBytes);
  } finally { await create.close(); }

  const reopened = new SqliteTreeStore(root);
  try {
    const k = createKernel({ store: reopened, clock });
    const detail = await k.dispatch('human', 'readNode', { treeId: 'T1', nodeId: added });
    expect(detail.node).toMatchObject({ parentId: 'T1.2.4', confirmation: 'humanConfirmed' });
    expect(detail.currentChange?.by).toBe('ai');
    const history = await k.dispatch('human', 'readHistory', { treeId: 'T1', nodeId: added, limit: 10 });
    expect(history.items.map(item => item.id)).toContain(confirmation);
    const pending = await k.dispatch('ai', 'readUnconfirmed', { treeId: 'Load', by: ['ai'], limit: 2 });
    expect(pending.items).toHaveLength(2); expect(pending.next).toBeDefined();
    const readOnly = new DatabaseSync(join(root, '.converge', 'Load.sqlite'), { readOnly: true });
    try { expect(readOnly.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); }
    finally { readOnly.close(); }
    console.info('SQLite 隔离实测', { root, seedBytes, dbBytes: statSync(join(root, '.converge', 'Load.sqlite')).size,
      writes: 40, fanout: 256, inbound: 255, budget, maxViewBytes, avgWriteMs: +(writeMs / 40).toFixed(2), avgReadMs: +(readMs / 40).toFixed(2) });
  } finally { await reopened.close(); }
}, 30_000);
