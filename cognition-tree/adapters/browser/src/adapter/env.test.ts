/**
 * 浏览器适配层联测：正式内核 + localStorage 测试存储 + 人/AI 两个可信入口。
 *
 * 覆盖验收主流程：导入样例、浏览、AI 执行变更、人确认、剪除与重新启用；
 * 以及写失败回滚、重开、损坏、开发坞真实读数与延迟/失败控制。
 * 不开浏览器、不做 UI 探针；这里只验证端口装配与内核语义。
 */
import { describe, expect, it } from 'vitest';
import type { Expand, TreeView } from '@cognition-tree/kernel/types';
import { createBrowserEnv } from './env';
import { createT1Seed } from '../fixtures/t1-seed';
import { MemoryStorage } from './storage/memory-storage.test-util';

/** 全树读取参数：从根读到叶子，引用跳一跳。 */
const EXPAND: Expand = { subtreeDepth: 'leaf', jumpHops: 1, direction: 'both', jumpFrom: 'expanded', afterJumpDepth: 0 };
const BUDGET = { maxScans: 20000, maxNodes: 2000, maxBytes: 1_000_000 };

/** 从根读整棵树。 */
async function readAll(treeId: string, human: ReturnType<typeof createBrowserEnv>['human']): Promise<TreeView> {
  return human.call('readView', { treeId, focus: { root: true }, expand: EXPAND, budget: BUDGET, onLimit: 'fold' });
}

describe('浏览器适配层联测', () => {
  it('导入样例 → 浏览 → AI 变更 → 人确认 → 剪除 → 重新启用', async () => {
    const storage = new MemoryStorage();
    const env = createBrowserEnv({ treeId: 'T1', repoRoot: 'D:/examples/converge-fixture/', storage });
    const notices: { stamp: number; count: number }[] = [];
    const off = env.human.watch('T1', (change) => notices.push({ stamp: change.stamp, count: change.revisions.length }));

    // 空状态：树不存在。
    await expect(readAll('T1', env.human)).rejects.toMatchObject({ code: 'missing' });
    expect(env.dev.stamp()).toBeNull();

    // 人在空状态里导入样例：一次提交创建整棵树，并发出一次提交通知。
    expect(await env.human.call('bootstrapTree', { seed: createT1Seed() })).toBe('T1');
    expect(notices).toEqual([{ stamp: 1, count: 10 }]);
    expect(env.dev.stamp()).toBe(1);

    const view = await readAll('T1', env.human);
    expect(view.nodes).toHaveLength(15);
    expect(view.rootId).toBe('T1');
    expect(view.complete).toBe(true);
    expect(view.nodes.find((n) => n.id === 'T1.3')?.state).toBeUndefined();
    expect(view.nodes.find((n) => n.id === 'T1.2.4')?.confirmation).toBe('unconfirmed');

    // AI 以自己身份补一条子判断；不需要人批准，但只能记为未确认。
    const newNode = await env.ai.call('addBranch', {
      treeId: 'T1',
      placement: { parentId: 'T1.2.4', kind: 'supplement' },
      draft: { body: { title: 'AI 补的概念引用' }, state: 'open', refs: [] },
    });
    expect(newNode).toMatch(/^node-/);
    expect(view.nodes.some((n) => n.id === newNode)).toBe(false);
    const pending = await env.human.call('readUnconfirmed', { treeId: 'T1', by: ['ai'], limit: 10 });
    const target = pending.items.find(
      (p) => 'revisionId' in p && p.revisionId !== undefined && (p.nodeIds ?? []).includes(newNode),
    );
    expect(target && 'revisionId' in target).toBe(true);

    // 人确认这条 AI 变更；树形不变，只加一条确认记录。
    const confirmId = await env.human.call('confirm', {
      treeId: 'T1',
      target: { revisionId: (target as { revisionId: string }).revisionId },
    });
    expect(confirmId).toMatch(/^rev-/);
    const detail = await env.human.call('readNode', { treeId: 'T1', nodeId: newNode });
    expect(detail.node.confirmation).toBe('humanConfirmed');
    expect(detail.node.state).toBe('open');

    // AI 剪除一个判断；理由与复活条件随形成记录保存。
    await env.ai.call('decideNode', {
      treeId: 'T1',
      nodeId: 'T1.2.4',
      decision: { type: 'prune', reason: 'AI 认为先放一放', reviveWhen: '出现重复定义时' },
    });
    expect((await env.human.call('readNode', { treeId: 'T1', nodeId: 'T1.2.4' })).node.state).toBe('prune');

    // 人重新启用为未决；旧剪除记录保留在历史里。
    await env.human.call('decideNode', {
      treeId: 'T1',
      nodeId: 'T1.2.4',
      decision: { type: 'revive', state: 'open', reason: '定义真的开始重复了' },
    });
    const revived = (await env.human.call('readNode', { treeId: 'T1', nodeId: 'T1.2.4' })).node;
    expect(revived.state).toBe('open');
    const history = await env.human.call('readHistory', { treeId: 'T1', nodeId: 'T1.2.4', limit: 10 });
    const actions = history.items.map((r) => (r.detail && 'action' in r.detail ? r.detail.action : null));
    expect(actions).toContain('prune');
    expect(actions).toContain('revive');

    // 每次写都发一次通知，版本单调。
    expect(notices.map((n) => n.stamp)).toEqual([1, 2, 3, 4, 5]);
    expect(env.dev.stamp()).toBe(5);
    off();
  });

  it('AI 不能人确认，也不能自举；人确认不能被 AI 冒用', async () => {
    const env = createBrowserEnv({ treeId: 'T1', repoRoot: 'D:/examples/converge-fixture/', storage: new MemoryStorage() });
    await expect(
      env.ai.call('bootstrapTree', { seed: createT1Seed() }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await env.human.call('bootstrapTree', { seed: createT1Seed() });
    await expect(
      env.ai.call('confirm', { treeId: 'T1', target: { seedNodeId: 'T1.2.4' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('失败注入：原地报存储失败，树与日志都不变；下一次正常记下', async () => {
    const env = createBrowserEnv({ treeId: 'T1', repoRoot: 'D:/examples/converge-fixture/', storage: new MemoryStorage() });
    await env.human.call('bootstrapTree', { seed: createT1Seed() });
    const before = env.dev.stamp();

    env.dev.armFailure();
    await expect(
      env.human.call('decideNode', {
        treeId: 'T1',
        nodeId: 'T1.3.2',
        decision: { type: 'revive', state: 'open', reason: '条件变了' },
      }),
    ).rejects.toMatchObject({ code: 'storage' });
    expect(env.dev.stamp()).toBe(before);
    expect((await env.human.call('readNode', { treeId: 'T1', nodeId: 'T1.3.2' })).node.state).toBe('prune');

    await env.human.call('decideNode', {
      treeId: 'T1',
      nodeId: 'T1.3.2',
      decision: { type: 'revive', state: 'open', reason: '条件变了' },
    });
    expect(env.dev.stamp()).toBe((before ?? 0) + 1);
    expect((await env.human.call('readNode', { treeId: 'T1', nodeId: 'T1.3.2' })).node.state).toBe('open');
  });

  it('重开页面从 localStorage 重放同一棵树；开发坞读数是实测', async () => {
    const storage = new MemoryStorage();
    const first = createBrowserEnv({ treeId: 'T1', repoRoot: 'D:/examples/converge-fixture/', storage });
    await first.human.call('bootstrapTree', { seed: createT1Seed() });
    await readAll('T1', first.human);
    const observed = first.dev.lastRead();
    expect(observed?.nodes).toBe(15);
    expect(observed?.bytes).toBeGreaterThan(0);
    expect(observed && 'scans' in observed).toBe(false);

    await first.ai.call('addBranch', {
      treeId: 'T1',
      placement: { parentId: 'T1.3', kind: 'branch' },
      draft: { body: { title: '重开后还在' }, state: 'open', refs: [] },
    });
    const bytes = first.dev.storageBytes();
    expect(bytes).toBeGreaterThan(0);

    const second = createBrowserEnv({ treeId: 'T1', repoRoot: 'D:/examples/converge-fixture/', storage });
    expect(second.dev.stamp()).toBe(2);
    const view = await readAll('T1', second.human);
    expect(view.nodes.some((n) => n.title === '重开后还在')).toBe(true);
    expect(view.refs).toHaveLength(7);
    expect(second.dev.storageBytes()).toBe(bytes);
  });

  it('存储损坏时读操作明确报 storage，不悄悄当空树', async () => {
    const storage = new MemoryStorage({
      'converge.cognition-tree.test.v2:tree:T1:head': '{broken',
    });
    const env = createBrowserEnv({ treeId: 'T1', repoRoot: 'D:/examples/converge-fixture/', storage });
    await expect(readAll('T1', env.human)).rejects.toMatchObject({ code: 'storage' });
    expect(env.dev.stamp()).toBeNull();
  });

  it('模拟延迟发生在调用前，开发坞可调', async () => {
    const env = createBrowserEnv({ treeId: 'T1', repoRoot: 'D:/examples/converge-fixture/', storage: new MemoryStorage() });
    await env.human.call('bootstrapTree', { seed: createT1Seed() });
    env.dev.setLatency(60);
    const started = Date.now();
    await readAll('T1', env.human);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(env.dev.latency()).toBe(60);
    env.dev.setLatency(0);
  });
});
