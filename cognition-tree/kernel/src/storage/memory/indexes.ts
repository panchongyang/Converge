/**
 * 内存存储的排序索引（接口单 3.3 的索引职责）。
 *
 * 职责：按父节点组织子节点、按引用两端组织边、按 (at, revisionId) 组织时间线、
 * 按 (nodeId, at, revisionId) 组织节点历史；写入时只插入受影响的键，
 * 旧快照持有旧根，不从全表重建。
 * 边界：索引值是稳定 ID 或不可变对象；不判断业务合法性，也不复制整棵树。
 * 协作：transaction 提供本次写入；commit 基于当前根生成下一组根；
 * snapshot 从捕获的根按键 seek 分批读取。
 */
import type { CognitionNode, NodeId, Ref, Revision } from '../../types';
import { OrderedMap } from './ordered-map';
import {
  compareChildKeys,
  compareNodeRevisionKeys,
  compareRefKeys,
  compareTimeKeys,
  revisionTimeKey,
  type ChildKey,
  type NodeRevisionKey,
  type RefKey,
  type TimeKey,
} from './keys';

/** 一棵树当前已提交的索引根；字段整体替换，快照捕获后不再变化。 */
export interface IndexRoots {
  /** 子节点：[父节点, 子节点] -> 子节点 ID；根节点不进这张表。 */
  readonly children: OrderedMap<ChildKey, NodeId>;
  /** 出向引用：[起点, 引用 ID] -> 引用。 */
  readonly refsFrom: OrderedMap<RefKey, Ref>;
  /** 树内入向引用：[目标节点, 引用 ID] -> 引用；外部材料不进这张表。 */
  readonly refsTo: OrderedMap<RefKey, Ref>;
  /** 树时间线：[时间排序键, 修订 ID] -> 修订。 */
  readonly revisionsByTime: OrderedMap<TimeKey, Revision>;
  /** 节点历史：[节点 ID, 时间排序键, 修订 ID] -> 修订。 */
  readonly revisionsByNode: OrderedMap<NodeRevisionKey, Revision>;
}

/**
 * 创建一棵树的空索引。
 * @returns 五张空索引
 */
export function createIndexRoots(): IndexRoots {
  return {
    children: OrderedMap.empty(compareChildKeys),
    refsFrom: OrderedMap.empty(compareRefKeys),
    refsTo: OrderedMap.empty(compareRefKeys),
    revisionsByTime: OrderedMap.empty(compareTimeKeys),
    revisionsByNode: OrderedMap.empty(compareNodeRevisionKeys),
  };
}

/**
 * 根据一次节点写入更新子节点索引；同一父节点下不改键，移动父节点时先删旧键。
 * @param roots 当前索引根
 * @param before 写入前的已提交行；新节点为 null
 * @param after 写入后的节点行
 * @returns 可能包含新子节点索引的根对象
 */
export function updateChildren(
  roots: IndexRoots,
  before: CognitionNode | null,
  after: CognitionNode,
): IndexRoots {
  const oldParent = before?.parentId ?? null;
  const newParent = after.parentId;
  if (oldParent === newParent) return roots;
  let children = roots.children;
  if (oldParent !== null) {
    children = children.delete([oldParent, after.id]);
  }
  if (newParent !== null) {
    children = children.set([newParent, after.id], after.id);
  }
  return children === roots.children ? roots : { ...roots, children };
}

/**
 * 把一条新引用插入出向与树内入向索引；外部材料目标只进出向索引。
 * @param roots 当前索引根
 * @param ref 新引用
 * @returns 含新引用索引的根对象
 */
export function addRefToIndexes(roots: IndexRoots, ref: Ref): IndexRoots {
  const from = roots.refsFrom.set([ref.from, ref.id], ref);
  if (ref.target.nodeId === undefined) {
    return { ...roots, refsFrom: from };
  }
  const to = roots.refsTo.set([ref.target.nodeId, ref.id], ref);
  return { ...roots, refsFrom: from, refsTo: to };
}

/**
 * 把一条新修订插入时间线与每个关联节点的历史索引；关联 ID 去重。
 * @param roots 当前索引根
 * @param revision 新修订
 * @returns 含新修订索引的根对象
 */
export function addRevisionToIndexes(roots: IndexRoots, revision: Revision): IndexRoots {
  const timeKey = revisionTimeKey(revision.at, revision.id);
  const byTime = roots.revisionsByTime.set(timeKey, revision);
  let byNode = roots.revisionsByNode;
  const seen = new Set<NodeId>();
  for (const nodeId of revision.nodeIds) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    byNode = byNode.set([nodeId, timeKey[0], revision.id], revision);
  }
  return { ...roots, revisionsByTime: byTime, revisionsByNode: byNode };
}
