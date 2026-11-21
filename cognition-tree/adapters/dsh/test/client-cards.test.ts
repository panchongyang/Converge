/** 聊天写入卡的 ABI 边界：读 PartialArguments 访问器、失败不提供确认、只认本工具 meta。 */
import { describe, expect, it } from 'vitest';
import { AI_TOOLS } from '../src/types/wire';
import { cardActionTarget, readWriteCard, WRITE_TOOL_NAMES, type ToolBlock } from '../src/client/cards';

/**
 * PartialArguments 的最小访问器替身：text 读流式字符串，value 只读已闭合值。
 * 用 set 模拟“准备中就地增长”；读取方不得缓存结果。
 */
function partialArguments(fields: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(fields));
  return {
    text(key: string): string | undefined {
      const value = values.get(key);
      return typeof value === 'string' ? value : undefined;
    },
    value(key: string): unknown {
      const value = values.get(key);
      return value === undefined || typeof value === 'string' ? undefined : value;
    },
    set(key: string, value: unknown): void {
      values.set(key, value);
    },
  };
}

const addArgs = () =>
  partialArguments({
    treeId: 'T1',
    placement: { parentId: 'T1.2', kind: 'branch' },
    draft: { origin: { kind: 'branch' }, body: { title: '新判断', note: '依据 A' } },
  });

const decideArgs = () =>
  partialArguments({
    treeId: 'T1',
    nodeId: 'T1.2.1',
    decision: { type: 'prune', reason: '被更强的依据取代', reviveWhen: '出现新证据' },
  });

const successMeta = (op: 'addBranch' | 'decideNode', treeId = 'T1', nodeId = 'T1.2.2') =>
  ({ kind: 'cognition-tree', op, treeId, nodeId });

describe('聊天写入卡投影（真实块 ABI）', () => {
  it('准备中的访问器会增长：每次读都取当前值，不缓存 plain object', () => {
    const args = partialArguments();
    expect(readWriteCard({ phase: 'preparing', name: AI_TOOLS.addBranch, args }, AI_TOOLS.addBranch)!.treeId).toBeNull();
    args.set('treeId', 'T1');
    expect(readWriteCard({ phase: 'preparing', name: AI_TOOLS.addBranch, args }, AI_TOOLS.addBranch)!.treeId).toBe('T1');
  });

  it('成功 addBranch 的确认目标只取本工具 presentationMeta', () => {
    const block: ToolBlock = {
      kind: 'tool-result',
      isError: false,
      name: AI_TOOLS.addBranch,
      args: addArgs(),
      meta: successMeta('addBranch'),
    };
    const model = readWriteCard(block, AI_TOOLS.addBranch)!;
    expect(model.status).toBe('succeeded');
    expect(model.nodeId).toBe('T1.2.2');
    expect(model.contextNodeId).toBe('T1.2.2');
    expect(model.title).toBe('新判断');
    expect(cardActionTarget(model, 'session-a').focus).toEqual({ treeId: 'T1', nodeId: 'T1.2.2' });
  });

  it('失败结果不提供确认，不断言写入成功或已回滚；即使 meta 误带旧节点也不用', () => {
    const block: ToolBlock = {
      kind: 'tool-result',
      isError: true,
      name: AI_TOOLS.decideNode,
      args: decideArgs(),
      meta: successMeta('decideNode'),
    };
    const model = readWriteCard(block, AI_TOOLS.decideNode)!;
    expect(model.status).toBe('failed');
    expect(model.statusText).toMatch(/未取得成功回执/);
    expect(cardActionTarget(model, 'session-a').focus).toBeNull();
    expect(cardActionTarget(model, 'session-a').context).toEqual({ treeId: 'T1', nodeId: 'T1.2.1' });
  });

  it('成功 decideNode 需要本工具 meta 才给确认；applyReplacement 中文为“执行替代”', () => {
    const missingMeta = readWriteCard(
      { kind: 'tool-result', isError: false, name: AI_TOOLS.decideNode, args: decideArgs() },
      AI_TOOLS.decideNode,
    )!;
    expect(missingMeta.status).toBe('succeeded');
    expect(cardActionTarget(missingMeta, 'session-a').focus).toBeNull();

    const replaced = readWriteCard(
      {
        kind: 'tool-result',
        isError: false,
        name: AI_TOOLS.decideNode,
        args: partialArguments({ treeId: 'T1', nodeId: 'T1.2.1', decision: { type: 'applyReplacement', reason: '新证据' } }),
        meta: successMeta('decideNode', 'T1', 'T1.2.1'),
      },
      AI_TOOLS.decideNode,
    )!;
    expect(replaced.title).toContain('执行替代');
    expect(cardActionTarget(replaced, 'session-a').focus).toEqual({ treeId: 'T1', nodeId: 'T1.2.1' });
  });

  it('meta 的 op/treeId/nodeId 必须精确属于本工具，否则不给确认', () => {
    const wrongOp = readWriteCard(
      {
        kind: 'tool-result',
        isError: false,
        name: AI_TOOLS.addBranch,
        args: addArgs(),
        meta: successMeta('decideNode', 'T1', 'T1.2.2'),
      },
      AI_TOOLS.addBranch,
    )!;
    expect(wrongOp.nodeId).toBeNull();
    expect(cardActionTarget(wrongOp, 'session-a').focus).toBeNull();
  });

  it('会话、树缺失时不给跳转；读工具与陌生工具返回 null', () => {
    const model = readWriteCard(
      { kind: 'tool-result', isError: false, name: AI_TOOLS.decideNode, args: decideArgs(), meta: successMeta('decideNode', 'T1', 'T1.2.1') },
    )!;
    expect(cardActionTarget(model, null).open).toBeNull();
    expect(cardActionTarget(model, '').focus).toBeNull();
    expect(readWriteCard({ kind: 'tool-result', name: AI_TOOLS.readView, args: partialArguments({ treeId: 'T1' }) })).toBeNull();
    expect(readWriteCard({ kind: 'tool-result', name: 'other_tool', args: partialArguments({ treeId: 'T1' }) })).toBeNull();
    expect(WRITE_TOOL_NAMES).toEqual([AI_TOOLS.addBranch, AI_TOOLS.decideNode]);
  });

  it('坏参数视图降级但不抛错，也不伪造 nodeId', () => {
    const model = readWriteCard({ kind: 'tool-result', isError: false, name: AI_TOOLS.addBranch, args: 'not-an-args-view' });
    expect(model).not.toBeNull();
    expect(model!.treeId).toBeNull();
    expect(model!.nodeId).toBeNull();
    expect(cardActionTarget(model!, 'session-a').open).toBeNull();
  });
});
