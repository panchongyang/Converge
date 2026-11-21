/**
 * 待确认分页的纯计算：把 readUnconfirmed 的一页页结果合成 UI 状态。
 *
 * 职责：
 * - 区分两种目标：形成记录（revisionId）与导入判断（seedNodeId）；
 * - 按内核顺序累积已读页，给出按节点索引与“还有更多”，不做全量计数；
 * - 标记哪些是 AI 变更（「待看」只数这一种）。
 * 边界：不认识 React、不发请求；页面大小与刷新时机由 usePending 决定。
 * 协作：usePending 调这里；App 用 items/byNode/hasMore，Inspector 用 byNode 判断子判断是否待确认。
 * 依据：docs/design/kernel-interfaces.md §3.1 的 PendingTarget / PendingPage。
 */
import type { ConfirmTarget, NodeId, PendingPage, PendingTarget, RevisionActor, RevisionId } from '../types/kernel';

/** 形成记录目标：尚未确认、且仍是至少一个节点 currentChange 的修订。 */
export type RevisionPending = Extract<PendingTarget, { revisionId: RevisionId }>;
/** 导入判断目标：没有日常变更、导入时确认程度为 unconfirmed 的节点。 */
export type SeedPending = Extract<PendingTarget, { seedNodeId: NodeId }>;

/**
 * 区分两项待确认目标。
 * @param p 待确认项
 */
export function isRevisionPending(p: PendingTarget): p is RevisionPending {
  return 'revisionId' in p && p.revisionId !== undefined;
}

/**
 * 待确认项对应的确认目标（confirm 的输入）。
 * @param p 待确认项
 */
export function pendingTargetOf(p: PendingTarget): ConfirmTarget {
  return isRevisionPending(p) ? { revisionId: p.revisionId } : { seedNodeId: p.seedNodeId };
}

/**
 * 待确认项涉及的节点：形成记录列出仍指向它的节点，导入判断就是它自己。
 * @param p 待确认项
 * @returns 至少一个稳定节点 ID
 */
export function pendingNodeIds(p: PendingTarget): NodeId[] {
  return isRevisionPending(p) ? p.nodeIds : [p.seedNodeId];
}

/**
 * 是否是一项 AI 变更（「待看」只数这一种；导入判断不算 AI 提议）。
 * @param p 待确认项
 */
export function isAiPending(p: PendingTarget): boolean {
  return isRevisionPending(p) && p.by === 'ai';
}

/** 已读到的待确认页：items 保持内核顺序，byNode 供按节点查。 */
export interface PendingList {
  items: PendingTarget[];
  /** 已读项按节点索引；同一节点只取先读到的一项（内核保证一个节点只指向一条当前变更）。 */
  byNode: Map<NodeId, PendingTarget>;
  /** 下一页起点；没有下一页时省略。 */
  next?: ConfirmTarget;
  /** 还有没读的页。 */
  hasMore: boolean;
}

/** 空列表。 */
export function emptyPending(): PendingList {
  return { items: [], byNode: new Map(), hasMore: false };
}

/**
 * 并入一页待确认结果。
 * @param prev 已读列表
 * @param page 新的一页
 * @param append true 表示向后翻页；false 表示从第一页重读
 */
export function mergePendingPage(prev: PendingList, page: PendingPage, append: boolean): PendingList {
  const items = append ? [...prev.items, ...page.items] : [...page.items];
  const byNode = new Map<NodeId, PendingTarget>();
  for (const item of items) {
    for (const id of pendingNodeIds(item)) if (!byNode.has(id)) byNode.set(id, item);
  }
  return { items, byNode, next: page.next, hasMore: page.next !== undefined };
}

/**
 * 要列出的执行者：AI 的变更与导入判断；人自己执行的变更不列入。
 * 由 UI 显式传给 readUnconfirmed，不使用缺省值。
 */
export const PENDING_ACTORS: RevisionActor[] = ['ai', 'import'];
