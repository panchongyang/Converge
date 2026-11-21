/**
 * 完整引用边。
 *
 * 职责：把引用 ID、起点节点、边类型与目标组合成一条有方向的边。
 * 边界：引用不是父子关系；反向查找不颠倒原边。引用只增不改。
 * 协作：node 的节点行旁不内嵌引用；read 的 TreeView、ports 的分批读与 seed 的原引用都用它。
 */
import type { NodeId, RefId } from './ids';
import type { RefKind, RefTarget } from './ref-target';

/** 有类型的引用边，保留原方向：from 指向 target。 */
export interface Ref {
  id: RefId;
  /** 起点节点；引用不是父子关系。 */
  from: NodeId;
  kind: RefKind;
  target: RefTarget;
}
