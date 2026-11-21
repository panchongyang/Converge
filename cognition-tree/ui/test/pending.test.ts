/**
 * 待确认分页纯逻辑：合并已读页、按节点索引、区分 AI 变更与导入判断。
 */
import { describe, expect, it } from 'vitest';
import {
  emptyPending,
  isAiPending,
  isRevisionPending,
  mergePendingPage,
  pendingNodeIds,
  pendingTargetOf,
} from '../src/models/pending';
import { pendingPage, revisionPending, seedPending } from './fixtures';

describe('待确认分页合并', () => {
  it('第一页替换旧列表，并保留下一页起点', () => {
    const next = { revisionId: 'rev-2' };
    const merged = mergePendingPage(emptyPending(), pendingPage([revisionPending('rev-1', ['T1.1'])], next), false);
    expect(merged.items).toHaveLength(1);
    expect(merged.hasMore).toBe(true);
    expect(merged.next).toEqual(next);
  });

  it('翻页向后累积；同一条形成记录的多个节点都可按节点找回', () => {
    const first = mergePendingPage(emptyPending(), pendingPage([revisionPending('rev-1', ['T1.1', 'T1.2'])], { revisionId: 'rev-2' }), false);
    const merged = mergePendingPage(first, pendingPage([revisionPending('rev-2', ['T1.3'])]), true);
    expect(merged.items.map((p) => (isRevisionPending(p) ? p.revisionId : ''))).toEqual(['rev-1', 'rev-2']);
    expect(merged.byNode.get('T1.1')).toEqual(first.items[0]);
    expect(merged.byNode.get('T1.2')).toEqual(first.items[0]);
    expect(merged.byNode.get('T1.3')).toEqual(merged.items[1]);
    expect(merged.hasMore).toBe(false);
  });

  it('导入判断按自身节点索引，不算 AI 提议', () => {
    const merged = mergePendingPage(emptyPending(), pendingPage([seedPending('T1.4')]), true);
    expect(merged.byNode.get('T1.4')).toEqual(merged.items[0]);
    expect(isAiPending(merged.items[0])).toBe(false);
    expect(pendingNodeIds(merged.items[0])).toEqual(['T1.4']);
    expect(pendingTargetOf(merged.items[0])).toEqual({ seedNodeId: 'T1.4' });
  });

  it('AI 变更按 revisionId 绑定确认目标；人执行的不算待看', () => {
    const ai = revisionPending('rev-1', ['T1.1']);
    const human = revisionPending('rev-2', ['T1.2'], 'human');
    expect(isAiPending(ai)).toBe(true);
    expect(isAiPending(human)).toBe(false);
    expect(pendingTargetOf(ai)).toEqual({ revisionId: 'rev-1' });
    expect(isRevisionPending(human)).toBe(true);
  });

  it('重读第一页会丢弃之前的翻页结果，不混两页', () => {
    const first = mergePendingPage(emptyPending(), pendingPage([revisionPending('rev-1', ['T1.1'])]), false);
    const again = mergePendingPage(first, pendingPage([revisionPending('rev-9', ['T1.9'])]), false);
    expect(again.items).toHaveLength(1);
    expect(again.byNode.has('T1.1')).toBe(false);
    expect(again.byNode.has('T1.9')).toBe(true);
  });
});
