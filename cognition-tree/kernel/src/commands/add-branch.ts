/** 新增分支的落点、草稿和引用规则（内核接口单 §3.1）。只生成变更计划，不直接写存储。 */
import { insertNode } from '../operations';
import type { BranchStateChange } from '../operations';
import type { CognitionNode, Draft, NodeBody, NodeId, Origin, Placement, WriteTransaction } from '../types';
import type { FormationPlan } from './formation';
import {
  branchState, invalid, list, nodeBody, onlyFields, record, refKind, refTarget, requireNode, requiredText,
} from './validation';

/** 已解析的真实落点、来历及独立草稿；模型随后分配新 ID。 */
interface PreparedBranch {
  parent: CognitionNode;
  origin: Origin;
  body: NodeBody;
  initial: BranchStateChange;
  refs: Draft['refs'];
}

/**
 * 在事务中验证落点、初始内容和所有引用，不分配 ID 或写入。
 * @param transaction 当前单树事务
 * @param placement 调用方选定的父节点或拟被替代节点，二选一
 * @param draft 仅描述新节点的草稿，不携带身份、确认或已有数据
 * @returns 已校验且与原请求分离的创建意图
 */
export async function prepareBranch(
  transaction: WriteTransaction,
  placement: Placement,
  draft: Draft,
): Promise<PreparedBranch> {
  const input = record(draft, '分支草稿');
  if (Object.hasOwn(input, 'title')) invalid('不要传 draft.title；标题必须写在 draft.body.title。');
  onlyFields(input, ['body', 'state', 'refs', 'pruneReason', 'reviveWhen'], '分支草稿');
  // 仍使用同一标题校验规则，只在新增分支时给出调用方可直接修正的参数路径。
  const bodyInput = record(input.body, 'draft.body（其中 draft.body.title 必填）');
  requiredText(bodyInput.title, 'draft.body.title');
  const body = nodeBody(bodyInput);
  const state = branchState(input.state);
  const initial = initialState(state, input.pruneReason, input.reviveWhen);
  const refs = Array.from(list(input.refs, '草稿引用'), parseDraftRef);
  const { parent, origin } = await resolvePlacement(transaction, placement);
  await validateTargets(transaction, parent, refs);
  return { parent, origin, body, initial, refs };
}

/**
 * 用模型分配的 ID 组装新节点、引用意图及形成记录；不触及关联节点的当前变更。
 * @param branch 已校验的落点及草稿
 * @param nodeId 分配给新节点的树内 ID
 * @returns 待同笔提交的新增计划
 */
export function planAddBranch(branch: PreparedBranch, nodeId: NodeId): FormationPlan {
  const { parent, origin, body, initial, refs } = branch;
  const labels = { branch: '新增分支', supplement: '补充', erratum: '勘误' };
  const action = origin.kind === 'replacement' ? `登记替代候选（替代 ${origin.replacesId}）` : labels[origin.kind];
  let summary = `${action} ${nodeId}「${body.title}」`;
  // AddBranchDetail 的正式契约只有 action/effects。初始剪除信息同时留在节点和该条不可改写的形成摘要，复活后仍可回查。
  if (initial.state === 'prune') {
    summary += `；初始为剪：${initial.pruneReason}；复活条件：${initial.reviveWhen}`;
  }
  const historyAnchor = origin.kind === 'replacement' ? origin.replacesId
    : origin.kind === 'branch' ? undefined : parent.id;
  return {
    changes: [insertNode({ id: nodeId, parentId: parent.id, body, origin }, initial)],
    action: { action: 'addBranch' },
    summary,
    ...(historyAnchor !== undefined ? { historyAnchor } : {}),
    outgoing: refs,
  };
}

/**
 * 根据落点取得真实父节点；替代候选与旧判断同父，登记不执行替代。
 * @param transaction 当前单树事务
 * @param placement 二选一的落点输入
 * @returns 事务内可定位的父节点及新节点的来历
 */
async function resolvePlacement(
  transaction: WriteTransaction,
  placement: Placement,
): Promise<{ parent: CognitionNode; origin: Origin }> {
  const value = record(placement, '落点');
  onlyFields(value, ['parentId', 'kind', 'replacesId'], '落点');
  if (value.replacesId !== undefined) {
    if (value.parentId !== undefined || value.kind !== undefined) {
      invalid('替代落点不能另指定父节点或落点类型');
    }
    const old = await requireNode(transaction, requiredText(value.replacesId, '被替代节点 ID'));
    if (old.parentId === null) invalid('根节点没有同级，不能被替代');
    return {
      parent: await requireNode(transaction, old.parentId),
      origin: { kind: 'replacement', status: 'proposed', replacesId: old.id },
    };
  }
  const kind = value.kind;
  if (kind !== 'branch' && kind !== 'supplement' && kind !== 'erratum') {
    invalid('指定父节点时须给出 branch、supplement 或 erratum 落点类型');
  }
  return {
    parent: await requireNode(transaction, requiredText(value.parentId, '父节点 ID')),
    origin: { kind },
  };
}

/**
 * 校验初始状态专用的剪除信息，不为草稿补默认值。
 * @param state 新节点的明确初始状态
 * @param pruneReason 剪除理由，只用于初始为剪的节点
 * @param reviveWhen 复活条件，只用于初始为剪的节点
 * @returns 可交给结构原语的明确状态写入
 */
function initialState(state: Draft['state'], pruneReason: unknown, reviveWhen: unknown): BranchStateChange {
  if (state === 'prune') {
    return {
      state,
      pruneReason: requiredText(pruneReason, '剪除理由'),
      reviveWhen: requiredText(reviveWhen, '复活条件'),
    };
  }
  if (pruneReason !== undefined || reviveWhen !== undefined) invalid('只有初始为剪才可给出剪除信息');
  return { state };
}

/**
 * 校验草稿只提供引用种类及指向，不允许调用方指定起点或边 ID。
 * @param value 一项待保存的引用意图
 * @returns 带独立目标副本的引用意图
 */
function parseDraftRef(value: unknown): Draft['refs'][number] {
  const input = record(value, '草稿引用项');
  onlyFields(input, ['kind', 'target'], '草稿引用项');
  return { kind: refKind(input.kind), target: refTarget(input.target) };
}

/**
 * 校验树内目标存在，依赖前提不得落在新节点的祖先链。同一目标只读取一次。
 * @param transaction 当前单树事务
 * @param parent 新节点的真实父节点，已由落点校验取得
 * @param refs 已校验形状的引用意图
 */
async function validateTargets(transaction: WriteTransaction, parent: CognitionNode, refs: Draft['refs']): Promise<void> {
  const nodes = new Map([[parent.id, parent]]);
  const premises = new Set<NodeId>();
  for (const { kind, target } of refs) {
    if (target.nodeId === undefined) continue;
    if (kind === 'premise') premises.add(target.nodeId);
    if (!nodes.has(target.nodeId)) nodes.set(target.nodeId, await requireNode(transaction, target.nodeId));
  }
  // 只有树内前提需要查询父链；其他引用不为验证多读祖先。
  if (premises.size === 0) return;
  const seen = new Set<NodeId>();
  let current: CognitionNode | null = parent;
  while (current !== null) {
    if (premises.has(current.id)) invalid(`依赖前提不能指向祖先节点 ${current.id}`);
    if (seen.has(current.id)) invalid(`节点 ${current.id} 的父链成环`);
    seen.add(current.id);
    const parentId: NodeId | null = current.parentId;
    current = parentId === null ? null : nodes.get(parentId) ?? await requireNode(transaction, parentId);
  }
}
