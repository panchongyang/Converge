/**
 * 节点的分支状态与确认程度。
 *
 * 职责：定义“如何对待这个节点”和“当前变更是否由人确认”两个正交标记。
 * 边界：两者都不是置信度；确认程度不表示执行者，也不决定变更是否生效。
 * 协作：node 与 read 的节点行、revision 的效果项、decision 的草稿都从这里取；
 * 手稿未载时省略字段，不用 null 代替。
 */

/**
 * 分支状态：如何对待这个判断。
 * keep 留在树上、prune 剪除但保留节点与理由、open 尚未决定。
 */
export type BranchState = 'keep' | 'prune' | 'open';

/**
 * 确认程度：只表示当前变更是否由人确认，与谁执行无关，也不是置信度。
 * unconfirmed 尚未有人确认；humanConfirmed 已由人确认。
 */
export type Confirmation = 'unconfirmed' | 'humanConfirmed';
