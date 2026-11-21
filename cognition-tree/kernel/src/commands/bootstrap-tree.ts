/** §3.4 一次性自举的结构校验。树数据仍由适配器翻译、models 一次提交；这里不读手稿或时钟。 */
import type { NodeId, Origin, Ref, SeedNode, SeedTree } from '../types';
import { seedHistoryEntry } from './seed-history';
import { branchState, invalid, list, nodeBody, onlyFields, optionalText, record, refKind, refTarget, requiredText } from './validation';

/** 一次根部遍历的区间；用于常数次比较判断祖先，不沿每条引用重复走父链。 */
interface Interval { enter: number; leave: number }

/**
 * 验证并复制整份种子。保留节点和引用 ID、历史行序与手稿缺项；不生成当前变更或新确认。
 * @param seed 适配器译出的自举树、引用与原历史
 * @returns 可在一笔新建事务里写入的独立种子
 */
export function prepareBootstrap(seed: SeedTree): SeedTree {
  const data = record(seed, '自举种子');
  onlyFields(data, ['treeId', 'rootId', 'nodes', 'refs', 'history'], '自举种子');
  const treeId = requiredText(data.treeId, '目标树 ID');
  const rootId = requiredText(data.rootId, '根节点 ID');
  const nodes = Array.from(list(data.nodes, '种子节点'), seedNode);
  const byId = new Map<NodeId, SeedNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) invalid(`种子节点 ID ${node.id} 重复`);
    byId.set(node.id, node);
  }
  const intervals = treeIntervals(rootId, byId);
  const refs = Array.from(list(data.refs, '种子引用'), seedRef);
  validateSeedRefs(refs, intervals);
  const ids = new Set(byId.keys());
  const history = Array.from(list(data.history, '种子历史'), (entry) => seedHistoryEntry(entry, ids));
  return { treeId, rootId, nodes, refs, history };
}

/**
 * 校验并复制单条种子节点；保留手稿明确留下的状态、确认来源和剪除字段，不接受 currentChange。
 * @param value 手稿转写的一条种子节点
 * @returns 原 ID 不变的独立节点行
 */
function seedNode(value: unknown): SeedNode {
  const data = record(value, '种子节点');
  onlyFields(data, ['id', 'parentId', 'body', 'origin', 'state', 'confirmation', 'pruneReason', 'reviveWhen'], '种子节点');
  const node: SeedNode = {
    id: requiredText(data.id, '种子节点 ID'),
    parentId: data.parentId === null ? null : requiredText(data.parentId, '种子父节点 ID'),
    body: nodeBody(data.body),
    origin: seedOrigin(data.origin),
  };
  if (data.state !== undefined) node.state = branchState(data.state);
  const confirmation = data.confirmation;
  if (confirmation !== undefined) {
    if (confirmation !== 'unconfirmed' && confirmation !== 'humanConfirmed') invalid('种子确认程度不合规');
    node.confirmation = confirmation;
  }
  const pruneReason = optionalText(data.pruneReason, '种子剪除理由');
  const reviveWhen = optionalText(data.reviveWhen, '种子复活条件');
  if (pruneReason !== undefined) node.pruneReason = pruneReason;
  if (reviveWhen !== undefined) node.reviveWhen = reviveWhen;
  return node;
}

/**
 * 复制一条种子来历；替代旧判断与候选的位置稍后用同一份种子校验。
 * @param value 种子已有的节点来历
 * @returns 合规的来历副本
 */
function seedOrigin(value: unknown): Origin {
  const data = record(value, '种子来历');
  const kind = data.kind;
  if (kind === 'branch' || kind === 'supplement' || kind === 'erratum') {
    onlyFields(data, ['kind'], '种子来历');
    return { kind };
  }
  if (kind !== 'replacement') invalid('种子来历类型不合规');
  onlyFields(data, ['kind', 'status', 'replacesId'], '种子替代来历');
  const status = data.status;
  if (status !== 'proposed' && status !== 'applied') invalid('种子替代来历必须标明是否已执行');
  return { kind, status, replacesId: requiredText(data.replacesId, '种子旧判断 ID') };
}

/**
 * 验证拓扑只有指定的根、所有节点能连回根且替代关系同父，并记录祖先区间。
 * @param rootId 适配器读到的手稿根节点 ID
 * @param nodes 已按唯一 ID 收集的种子节点
 * @returns 每个节点的遍历区间，供校验树内前提引用
 */
function treeIntervals(rootId: NodeId, nodes: ReadonlyMap<NodeId, SeedNode>): Map<NodeId, Interval> {
  if (nodes.get(rootId)?.parentId !== null) invalid('指定根必须在种子中且没有父节点');
  const children = new Map<NodeId, NodeId[]>();
  for (const { id, parentId, origin } of nodes.values()) {
    if (parentId === null && id !== rootId) invalid('种子只能有一个指定根');
    if (parentId !== null) {
      if (!nodes.has(parentId)) invalid(`种子节点 ${id} 的父节点 ${parentId} 不存在`);
      const siblings = children.get(parentId);
      if (siblings === undefined) children.set(parentId, [id]);
      else siblings.push(id);
    }
    if (origin.kind === 'replacement') {
      const old = nodes.get(origin.replacesId);
      if (old === undefined || old.id === id || parentId === null || old.parentId !== parentId) {
        invalid(`种子节点 ${id} 的替代来历未指向同级旧判断`);
      }
    }
  }
  // 每条父边已唯一；一个父链有环时不能连到指定根。用显式栈避免深链耗尽调用栈。
  const intervals = new Map<NodeId, Interval>();
  const stack: NodeId[] = [rootId];
  let id: NodeId | undefined;
  while ((id = stack.pop()) !== undefined) {
    const existing = intervals.get(id);
    if (existing !== undefined) {
      existing.leave = intervals.size;
      continue;
    }
    intervals.set(id, { enter: intervals.size, leave: 0 });
    stack.push(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  if (intervals.size !== nodes.size) invalid('种子包含无法沿父链到达指定根的节点');
  return intervals;
}

/**
 * 复制手稿的一条引用，原 ID、方向和局部定位保持不变。
 * @param value 手稿转写的一条引用
 * @returns 形状合规的引用；端点与唯一性稍后按树校验
 */
function seedRef(value: unknown): Ref {
  const data = record(value, '种子引用');
  onlyFields(data, ['id', 'from', 'kind', 'target'], '种子引用');
  return {
    id: requiredText(data.id, '种子引用 ID'),
    from: requiredText(data.from, '种子引用起点 ID'),
    kind: refKind(data.kind),
    target: refTarget(data.target),
  };
}

/**
 * 防止自举写入重复边 ID、悬空端点或指回祖先的前提引用；其他有环引用仍保留原方向。
 * @param refs 种子的原引用列表
 * @param nodes 各种子节点及其祖先区间
 */
function validateSeedRefs(refs: Ref[], nodes: ReadonlyMap<NodeId, Interval>): void {
  const ids = new Set<string>();
  for (const { id, from, kind, target } of refs) {
    if (ids.has(id)) invalid(`种子引用 ID ${id} 重复`);
    ids.add(id);
    const start = nodes.get(from);
    if (start === undefined) invalid(`种子引用 ${id} 的起点 ${from} 不存在`);
    if (target.nodeId !== undefined) {
      const end = nodes.get(target.nodeId);
      if (end === undefined) invalid(`种子引用 ${id} 的目标 ${target.nodeId} 不存在`);
      if (kind === 'premise' && end.enter < start.enter && start.enter < end.leave) {
        invalid(`种子依赖前提 ${id} 不能指向祖先节点`);
      }
    }
  }
}
