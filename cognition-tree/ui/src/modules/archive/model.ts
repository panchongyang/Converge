/**
 * 归档的共用文案与纯逻辑。
 *
 * 职责：给目录页与树视图的归档列表提供同一套标题、空/失败说明，以及“归档后落到哪里”的
 * 纯计算；组件只负责渲染和调用端口。
 * 边界：不访问 React、DOM、宿主或网络，也不判断归档是否成功；归档事实只以服务端读回为准。
 */

import type { NodeId, TreeId, ViewNode } from '../../types/kernel';
import type { ArchiveItem } from '../../types/ports';

/** 归档界面固定文案；整树与分支使用同一套说法，避免两个入口各说一套。 */
export const ARCHIVE_COPY = {
  /** 目录页工具栏。 */
  archivedTrees: '已归档的树',
  archivedTreesEmpty: '没有已归档的树。',
  archivedTreesDesc: '归档的树不会出现在全部树列表里；恢复后重新出现，内容不变。',
  /** 树视图顶栏与阅读栏。 */
  archivedBranches: '已归档',
  archivedBranchesTitle: '已归档的分支',
  archivedBranchesEmpty: '这棵树没有显式归档的分支。',
  archivedBranchesDesc: '归档只隐藏该判断及其整个子树；恢复后嵌套的显式归档标记仍保持隐藏。',
  /** 行内动作。 */
  archiveTree: '归档',
  archiveTreePending: '归档中…',
  archiveNode: '归档…',
  archiveRoot: '归档整棵树…',
  restore: '恢复',
  restoring: '恢复中…',
  /** 行内确认。 */
  confirmNode: '归档这个判断及其整个子树？可在「已归档」里恢复。',
  confirmRoot: '归档整棵树？它会从全部树列表移到「已归档的树」。',
  confirmAction: '归档',
  cancel: '取消',
  /** 通用状态。 */
  loading: '正在读取归档…',
  errorTitle: '没能读取归档',
  retry: '重试',
  close: '关闭',
  /** 操作失败前缀。 */
  archiveFailed: '没有归档：',
  restoreFailed: '没有恢复：',
  /** 标题缺失时的占位。 */
  untitled: '（无标题）',
} as const;

/**
 * 一行归档项的主标题；空白标题给出可读占位，不伪造内容。
 * @param item 归档项
 * @returns 去掉首尾空白后的标题，或统一占位
 */
export function archiveItemTitle(item: ArchiveItem): string {
  const title = item.title.trim();
  return title === '' ? ARCHIVE_COPY.untitled : title;
}

/**
 * 归档项的稳定键；整树与分支互不冲突。
 * @param item 归档项
 * @returns 用于 React key 与忙碌标记的键
 */
export function archiveItemKey(item: ArchiveItem): string {
  return item.treeId + ':' + (item.nodeId ?? '');
}

/**
 * 归档一个判断后应该落到哪里：最近的仍在当前视野里的祖先，没有则回到实际根。
 * 不返回 treeId——旧库的根 ID 不必等于树 ID。
 * @param nodeId 刚归档的判断
 * @param known 已读节点（提供 parentId 链）
 * @param visible 归档前仍在视野里的节点
 * @param rootId 本次读回的实际根
 * @returns 归档成功后要选中的判断
 */
export function archiveLanding(
  nodeId: NodeId,
  known: ReadonlyMap<NodeId, ViewNode>,
  visible: ReadonlySet<NodeId>,
  rootId: NodeId,
): NodeId {
  let current = known.get(nodeId)?.parentId ?? null;
  while (current) {
    if (visible.has(current)) return current;
    current = known.get(current)?.parentId ?? null;
  }
  return rootId;
}

/**
 * 判断一个节点是否落在某棵子树里（含祖先自身）。
 * 用于归档后决定视野是否还停在已隐藏的子树内；父链缺失时只认同一个节点。
 * @param nodeId 要检查的节点
 * @param ancestorId 可能的上层判断
 * @param known 已读节点（提供 parentId 链）
 * @returns 节点等于祖先或在其子树内时为 true
 */
export function isInSubtree(
  nodeId: NodeId,
  ancestorId: NodeId,
  known: ReadonlyMap<NodeId, ViewNode>,
): boolean {
  let current: NodeId | null = nodeId;
  while (current) {
    if (current === ancestorId) return true;
    current = known.get(current)?.parentId ?? null;
  }
  return false;
}

/**
 * 归档/恢复的定位参数：整树省略 nodeId，分支才带。
 * @param treeId 所属树
 * @param nodeId 分支节点；整树为 undefined
 * @returns 端口调用参数
 */
export function archiveTarget(treeId: TreeId, nodeId?: NodeId): { treeId: TreeId; nodeId?: NodeId } {
  return nodeId !== undefined ? { treeId, nodeId } : { treeId };
}
