/**
 * 内存 TreeStore 的公开配置与提交增量。
 *
 * 职责：定义构造参数与发布前回调；回调拿到本次事务实际写入的节点、引用与修订，
 * 供浏览器等宿主在内存数据发布前保存，失败时整笔事务回滚。
 * 边界：只描述本次写入，不是整棵树快照；宿主不得从增量反推或改写未列出的数据。
 * 协作：store 在发布前调用 beforeCommit；浏览器把同一增量经原端口 transact 回放。
 */
import type { CognitionNode, Ref, Revision, TreeId } from '../../types';

/** 一次成功提交实际写入的数据；数组只含本次变动的行。 */
export interface MemoryDelta {
  /** 本次新增或更新的完整节点行。 */
  nodes: CognitionNode[];
  /** 本次新增的引用边。 */
  refs: Ref[];
  /** 本次追加的修订记录。 */
  revisions: Revision[];
}

/**
 * 发布前回调：可在保存宿主数据时同步或异步失败；失败时本次提交不发布。
 * @param treeId 目标树
 * @param mode 本次事务模式：existing 修改已有树；createNew 新建或自举目标树
 * @param delta 本次事务写入的节点、引用与修订，独立副本，修改它不影响内存数据
 * @returns 完成后才发布；抛错或 reject 即回滚
 */
export type BeforeCommit = (
  treeId: TreeId,
  mode: 'existing' | 'createNew',
  delta: MemoryDelta,
) => void | Promise<void>;

/** MemoryTreeStore 的构造参数。 */
export interface MemoryTreeStoreOptions {
  /** 可选发布前回调；省略时只发布到内存。 */
  beforeCommit?: BeforeCommit;
}
