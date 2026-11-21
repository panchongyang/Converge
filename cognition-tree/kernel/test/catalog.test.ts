/** 操作目录的信任边界：使用与网页相同的分派入口，不用 UI 或工具来冒充人的确认。 */
import { describe, expect, it } from 'vitest';
import { createKernel } from '../src/catalog';
import { MemoryTreeStore } from '../src/storage/memory';
import type { SeedTree } from '../src/types';

/** 单个已确认根即可验证入口角色；不给模型预置一次日常变更。 */
function example(): SeedTree {
  return { treeId: 'one', rootId: 'root', nodes: [{ id: 'root', parentId: null,
    body: { title: '从哪开始？' }, origin: { kind: 'branch' }, confirmation: 'humanConfirmed' }], refs: [], history: [] };
}

describe('catalog 以可信调用点区分执行和确认', () => {
  it('AI 不可自举或确认；伪造 input.actor 不升权，不写任何日志', async () => {
    const kernel = createKernel({ store: new MemoryTreeStore(), clock: { now: () => '2026-11-20T12:00:00Z' } });
    const seed = example();
    await expect(kernel.dispatch('ai', 'bootstrapTree', { seed })).rejects.toMatchObject({ code: 'invalid' });
    await kernel.dispatch('human', 'bootstrapTree', { seed });
    const treeId = seed.treeId;
    const request = { treeId, actor: 'human', placement: { parentId: seed.rootId, kind: 'supplement' } as const,
      draft: { body: { title: '补一条判断' }, state: 'keep' as const, refs: [] } };
    const nodeId = await kernel.dispatch('ai', 'addBranch', request);
    const detail = await kernel.dispatch('ai', 'readNode', { treeId, nodeId });
    expect(detail.currentChange?.by).toBe('ai');
    const target = { revisionId: detail.currentChange!.id };
    const forged = { treeId, target, actor: 'human' };
    await expect(kernel.dispatch('ai', 'confirm', forged)).rejects.toMatchObject({ code: 'invalid' });
    const history = () => kernel.dispatch('human', 'readHistory', { treeId, limit: 10 });
    expect((await history()).items).toHaveLength(1);
    await kernel.dispatch('human', 'confirm', { treeId, target });
    expect((await history()).items).toHaveLength(2);
    expect((await kernel.dispatch('ai', 'readNode', { treeId, nodeId })).node.confirmation).toBe('humanConfirmed');
  });

  it('未知操作名或身份不可调用，即使名称来自 JS 原型链', async () => {
    const kernel = createKernel({ store: new MemoryTreeStore(), clock: { now: () => '2026-11-20T12:00:00Z' } });
    // @ts-expect-error 模拟未经过 TS 的入口。
    await expect(kernel.dispatch('ai', 'constructor', {})).rejects.toMatchObject({ code: 'invalid' });
    // @ts-expect-error import 是历史来源，不是调用身份。
    await expect(kernel.dispatch('import', 'bootstrapTree', { seed: example() })).rejects.toMatchObject({ code: 'invalid' });
  });
});
