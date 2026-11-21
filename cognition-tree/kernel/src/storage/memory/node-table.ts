/**
 * 内存存储的节点表（接口单 3.3 的 nodes / tree_meta 职责中的按 ID 定位部分）。
 *
 * 职责：用持久有序映射保存“节点 ID -> 当前行”，提交时只复制改动键的路径；
 * 读快照持有提交时的映射根，之后的新提交不会改变旧行，也不需要保留整棵树的历次全行。
 * 边界：只存不可变行；不做业务校验，不建父子索引（父子索引在 indexes）。
 * 协作：transaction 从映射根按 ID 读；commit 发布新根；snapshot 捕获旧根后按 ID 读。
 * 旧根只被仍打开的读快照引用，快照关闭后交由运行时回收。
 */
import type { CognitionNode, NodeId } from '../../types';
import { OrderedMap } from './ordered-map';
import { compareIds } from '../../utils';

/** 节点 ID 到当前行的持久映射根；每次提交整体替换。 */
export type NodeIndex = OrderedMap<NodeId, CognitionNode>;

/**
 * 创建空节点索引。
 * @returns 空映射
 */
export function createNodeIndex(): NodeIndex {
  return OrderedMap.empty(compareIds);
}

/**
 * 按 ID 取映射根里的节点行。
 * @param index 节点索引根
 * @param nodeId 节点 ID
 * @returns 节点行；不存在时为 null
 */
export function readNodeFromIndex(index: NodeIndex, nodeId: NodeId): CognitionNode | null {
  return index.get(nodeId) ?? null;
}

/**
 * 写入一条节点行并返回新根；已存在则替换为最新行。
 * @param index 原节点索引根
 * @param node 已提交形状的不可变节点行
 * @returns 含该行的新映射根
 */
export function putNodeInIndex(index: NodeIndex, node: CognitionNode): NodeIndex {
  return index.set(node.id, node);
}
