/**
 * 单次快照内的点查、历史与待确认分页。索引和排序由 ReadSnapshot 提供，queries 只取 limit+1，
 * 不加载全表、不重放历史、不重新计算未确认目标；每次成功或失败都释放快照。
 */
import { CognitionError } from '../types/index';
import type {
  ConfirmTarget, NodeDetail, Page, PendingPage, PendingTarget, ReadSnapshot, Revision,
  RevisionActor, TreeStore,
} from '../types/index';
import { actors, confirmTarget, id, object, pageLimit } from './validation';

/** 历史的显式分页输入；after 是上一页末项的稳定修订 ID。 */
export interface HistoryInput { nodeId?: string; limit: number; after?: string }
/** 未确认索引的显式筛选和分页输入；不存在执行者缺省值。 */
export interface UnconfirmedInput { by: RevisionActor[]; limit: number; after?: ConfirmTarget }

/**
 * 在一个一致读中执行短查询，并保证释放快照；保留原查询错误，避免 close 掩盖它。
 * @param store 所选工作区的树存储端口
 * @param treeId 目标树
 * @param read 不保留快照的查询工作
 */
export async function withSnapshot<T>(
  store: TreeStore, treeId: string, read: (snapshot: ReadSnapshot) => Promise<T>,
): Promise<T> {
  const snapshot = await store.openRead(treeId);
  let failed = false;
  try {
    return await read(snapshot);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await snapshot.close(); }
    catch (error) { if (!failed) throw error; }
  }
}

/**
 * 读取节点正文和当前形成记录的全文；不查询邻居或其余历史。
 * @param store 注入的树存储
 * @param treeId 目标树 ID
 * @param nodeId 目标节点 ID
 * @throws CognitionError 节点不存在时 missing；当前指针损坏时 storage
 */
export async function readNode(store: TreeStore, treeId: string, nodeId: string): Promise<NodeDetail> {
  id(treeId, '树 ID');
  id(nodeId, '节点 ID');
  return withSnapshot(store, treeId, async (snapshot) => {
    const node = await snapshot.readNode(nodeId);
    if (!node) throw new CognitionError('missing', '目标判断不存在。');
    // 隐去指针不等于导入判断：不给界面凭空生成一个 seed 确认目标。
    if (!node.currentChange && node.confirmation !== 'humanConfirmed' && await snapshot.hasUnprojectedCurrentChange?.(nodeId)) {
      return { node, confirmationUnavailable: true };
    }
    return completeNodeDetail(snapshot, node);
  });
}

/**
 * 点查与批量视图共同使用的详情投影；校验当前形成记录，没有指针便不读修订。
 * @param snapshot 读到该节点的快照
 * @param node 已经读到的完整节点
 * @param beforeRevision 可选的预算检查；有指针时，在查找修订之前调用
 * @throws CognitionError 当前指针缺失或指向不匹配的记录时 storage
 */
export async function completeNodeDetail(
  snapshot: ReadSnapshot, node: NodeDetail['node'], beforeRevision?: () => void,
): Promise<NodeDetail> {
  if (!node.currentChange) return { node };
  beforeRevision?.();
  const revision = await snapshot.readRevision(node.currentChange.revisionId);
  if (!revision || revision.kind !== 'formation' || revision.by === 'import'
    || revision.by !== node.currentChange.by
    || !revision.detail.effects.some((effect) => effect.nodeId === node.id)) {
    throw new CognitionError('storage', '当前变更指针未指向该判断的日常形成记录。');
  }
  return { node, currentChange: revision };
}

/**
 * 从时间索引读取一页修订；只额外探测一条，以决定是否返回 next。
 * @param store 注入的树存储
 * @param treeId 目标树
 * @param input 节点过滤、页大小与上一页末项，均不推定默认目标
 */
export async function readHistory(store: TreeStore, treeId: string, input: HistoryInput): Promise<Page<Revision>> {
  id(treeId, '树 ID');
  object(input, '历史参数');
  pageLimit(input.limit);
  if (input.nodeId !== undefined) id(input.nodeId, '节点 ID');
  if (input.after !== undefined) id(input.after, '历史分页起点');
  return withSnapshot(store, treeId, async (snapshot) => {
    if (input.nodeId !== undefined && !await snapshot.readNodeRow(input.nodeId)) {
      throw new CognitionError('missing', '目标判断不存在。');
    }
    const rows = await snapshot.listRevisions(input.nodeId ?? null, input.after ?? null, input.limit + 1);
    const items = rows.slice(0, input.limit);
    return rows.length > input.limit ? { items, next: items[items.length - 1].id } : { items };
  });
}

/**
 * 把一项待确认目标投影为下一页起点，不泄露条目中的正文或节点列表。
 * @param item 已返回给调用方的末项
 */
function pendingKey(item: PendingTarget): ConfirmTarget {
  return item.revisionId !== undefined ? { revisionId: item.revisionId } : { seedNodeId: item.seedNodeId };
}

/**
 * 从未确认索引读取一页，可直接把 items 里的目标交给 confirm；不扫描已确认节点。
 * @param store 注入的树存储
 * @param treeId 目标树
 * @param input 执行者非空子集、页大小与上一页末项对应目标
 */
export async function readUnconfirmed(
  store: TreeStore, treeId: string, input: UnconfirmedInput,
): Promise<PendingPage> {
  id(treeId, '树 ID');
  object(input, '待确认参数');
  pageLimit(input.limit);
  actors(input.by);
  if (input.after !== undefined) confirmTarget(input.after);
  return withSnapshot(store, treeId, async (snapshot) => {
    const rows = await snapshot.listUnconfirmed([...new Set(input.by)], input.after ?? null, input.limit + 1);
    const items = rows.slice(0, input.limit);
    return rows.length > input.limit ? { items, next: pendingKey(items[items.length - 1]) } : { items };
  });
}
