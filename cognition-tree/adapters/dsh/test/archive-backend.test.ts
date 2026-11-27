/** 真实打包 worker + SQLite；只在隔离工作区验证归档在两种调用角色中的实际可见性。 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { expect, it } from 'vitest';
import type { OpInput } from '@cognition-tree/kernel/catalog/contracts';
import { createBackend } from '../src/server/backend';
import type { ChangeNotice } from '../src/types/wire';

it('提交归档后两种角色都读不到、旧游标作废；恢复后引用和父链原样回归', async () => {
  const local = fileURLToPath(new URL('../../../../.local-work/', import.meta.url));
  mkdirSync(local, { recursive: true });
  const fixture = mkdtempSync(join(local, 'archive-worker-'));
  const workspace = join(fixture, 'workspace');
  const other = join(fixture, 'other');
  mkdirSync(workspace);
  mkdirSync(other);
  const worker = join(fixture, 'worker.mjs');
  const bundle = await rolldown({ input: fileURLToPath(new URL('../src/server/backend/worker.ts', import.meta.url)), platform: 'node', external: [/^node:/] });
  try { await bundle.write({ file: worker, format: 'esm', codeSplitting: false }); }
  finally { await bundle.close(); }

  const backend = createBackend(pathToFileURL(worker));
  const notices: ChangeNotice[] = [];
  backend.watch((root, change) => { if (root === workspace && change.visibilityChanged) notices.push(change); });
  const treeId = 'T';
  const view = {
    treeId, focus: { root: true }, expand: { subtreeDepth: 'leaf', jumpHops: 1, direction: 'both', jumpFrom: 'expanded', afterJumpDepth: 0 },
    budget: { maxScans: 500, maxNodes: 100, maxBytes: 50_000 }, onLimit: 'exact', includeDetails: true,
  } satisfies OpInput['readView'];
  /** 写一项判断并取得真实 ID。@param parentId 真实父节点。@param title 测试标题。@param refs 指向树内判断的引用。 */
  const add = (parentId: string, title: string, refs: OpInput['addBranch']['draft']['refs'] = []) => backend.call(
    workspace, 'ai', 'addBranch', { treeId, placement: { parentId, kind: 'branch' }, draft: { body: { title }, state: 'keep', refs } },
  );

  try {
    await backend.call(workspace, 'human', 'createTree', { treeId, rootQuestion: '根问题' });
    await backend.call(other, 'human', 'createTree', { treeId, rootQuestion: '另一工作区' });
    const keep = await add(treeId, '仍显示');
    const parent = await add(treeId, '待归档父节点', [{ kind: 'example', target: { nodeId: keep } }]);
    const child = await add(parent, '待归档子节点');
    const outside = await add(treeId, '外部分支', [{ kind: 'premise', target: { nodeId: child } }]);
    const initial = await backend.call(workspace, 'human', 'readView', view);
    expect(initial.refs.map(ref => ref.from).sort()).toEqual([parent, outside].sort());
    const query = { ...view, onLimit: 'fold' as const, budget: { ...view.budget, maxNodes: 1 } };
    const first = await backend.call(workspace, 'ai', 'readView', query);
    expect(first.cursor).toBeDefined();

    await expect(backend.archive(workspace, { action: 'archive', treeId, nodeId: parent })).resolves.toBeNull();
    expect(notices).toEqual([{ treeId, stamp: initial.stamp + 1, revisions: [], visibilityChanged: true }]);
    await expect(backend.archive(workspace, { action: 'list', treeId })).resolves.toEqual([{ treeId, nodeId: parent, title: '待归档父节点' }]);
    await expect(backend.call(workspace, 'ai', 'readView', { ...query, cursor: first.cursor })).rejects.toMatchObject({ code: 'viewExpired' });
    await expect(backend.call(workspace, 'human', 'readNode', { treeId, nodeId: child })).rejects.toMatchObject({ code: 'missing' });
    await expect(backend.call(workspace, 'ai', 'readView', { ...view, focus: parent })).rejects.toMatchObject({ code: 'missing' });
    const visible = await backend.call(workspace, 'ai', 'readView', view);
    expect(visible.nodes.map(node => node.id).sort()).toEqual([treeId, keep, outside].sort());
    expect(visible.refs).toEqual([]);

    await backend.archive(workspace, { action: 'archive', treeId });
    await expect(backend.listTrees(workspace)).resolves.toEqual({ trees: [], unavailable: [] });
    await expect(backend.archive(workspace, { action: 'list' })).resolves.toEqual([{ treeId, title: '根问题' }]);
    await expect(backend.call(workspace, 'ai', 'readHistory', { treeId, limit: 5 })).rejects.toMatchObject({ code: 'missing' });
    await expect(backend.listTrees(other)).resolves.toMatchObject({ trees: [{ treeId, rootQuestion: '另一工作区' }] });

    await backend.archive(workspace, { action: 'restore', treeId });
    await expect(backend.call(workspace, 'human', 'readNode', { treeId, nodeId: parent })).rejects.toMatchObject({ code: 'missing' });
    await backend.archive(workspace, { action: 'restore', treeId, nodeId: parent });
    const restored = await backend.call(workspace, 'human', 'readView', view);
    expect(restored.nodes).toEqual(initial.nodes);
    expect(restored.refs).toEqual(initial.refs);
    expect(notices).toHaveLength(4);
  } finally { await backend.close(); }
});
