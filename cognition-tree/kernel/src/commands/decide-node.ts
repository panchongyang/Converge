/** 日常取舍的状态转换与替代规则（内核接口单 §3.1）。只读取受影响的节点，返回形成计划。 */
import { changeOrigin, changeState } from '../operations';
import type { BranchStateChange } from '../operations';
import type { CognitionNode, Decision, NodeId, PreviousPrune, WriteTransaction } from '../types';
import type { FormationPlan } from './formation';
import { invalid, onlyFields, openOrKeep, record, requiredText, requireNode } from './validation';

/**
 * 校验命令字段与当前状态，解释四种日常决定；人和 AI 使用同一套转换规则。
 * @param transaction 当前单树事务
 * @param nodeId 被操作的稳定节点 ID；执行替代时指候选
 * @param decision 决定、明确目标状态及理由，不携执行者或确认信息
 * @returns 待同笔提交的节点和形成记录计划，首项为被操作节点
 */
export async function planDecision(
  transaction: WriteTransaction,
  nodeId: NodeId,
  decision: Decision,
): Promise<FormationPlan> {
  const id = requiredText(nodeId, '节点 ID');
  const input = record(decision, '节点决定');
  const type = input.type;
  if (type !== 'prune' && type !== 'revive' && type !== 'setOpenOrKeep' && type !== 'applyReplacement') {
    invalid('节点决定只接受剪除、重新启用、留与未决转换或执行替代');
  }
  const reason = requiredText(input.reason, '决定理由');
  const node = await requireNode(transaction, id);

  switch (type) {
    case 'prune': {
      onlyFields(input, ['type', 'reason', 'reviveWhen'], '剪除决定');
      const reviveWhen = requiredText(input.reviveWhen, '复活条件');
      if (node.parentId === null) invalid('根节点不可剪除');
      if (node.state === 'prune') invalid(`节点 ${id} 已被剪除`);
      return {
        changes: [changeState(node, { state: 'prune', pruneReason: reason, reviveWhen })],
        action: { action: type, reason, reviveWhen },
        summary: `剪除 ${id}「${node.body.title}」`,
      };
    }
    case 'revive': {
      onlyFields(input, ['type', 'state', 'reason'], '重新启用决定');
      const state = openOrKeep(input.state);
      if (node.state !== 'prune') invalid('只可重新启用已剪除的节点');
      const previousPrune = pruneHistory(node);
      return {
        changes: [changeState(node, { state })],
        action: { action: type, state, reason, ...(previousPrune !== undefined ? { previousPrune } : {}) },
        summary: `重新启用 ${id}「${node.body.title}」为${state === 'keep' ? '留' : '未决'}`,
      };
    }
    case 'setOpenOrKeep': {
      onlyFields(input, ['type', 'state', 'reason'], '留与未决转换决定');
      const state = openOrKeep(input.state);
      if (node.parentId === null) invalid('根节点不能执行留与未决转换');
      if (node.origin.kind === 'replacement' && node.origin.status === 'proposed') {
        invalid('待执行的替代候选不能执行留与未决转换');
      }
      if (node.state === 'prune') invalid('已剪除的节点须用重新启用恢复');
      if (node.state === state) invalid('留与未决转换必须改变分支状态');
      return {
        changes: [changeState(node, { state })],
        action: { action: type, state, reason },
        summary: `将 ${id}「${node.body.title}」定为${state === 'keep' ? '留' : '未决'}`,
      };
    }
    case 'applyReplacement': {
      onlyFields(input, ['type', 'reason', 'reviveWhen'], '执行替代决定');
      return planReplacement(transaction, node, { state: 'prune', pruneReason: reason,
        reviveWhen: requiredText(input.reviveWhen, '复活条件') });
    }
  }
}

/**
 * 把当前有记载的剪除信息留到重新启用记录；不为手稿补缺项。
 * @param node 重新启用前的已剪节点
 * @returns 已知的剪除信息；全无记载时不生成明细项
 */
function pruneHistory(node: CognitionNode): PreviousPrune | undefined {
  const { pruneReason, reviveWhen } = node;
  if (pruneReason === undefined && reviveWhen === undefined) return undefined;
  return {
    ...(pruneReason !== undefined ? { pruneReason } : {}),
    ...(reviveWhen !== undefined ? { reviveWhen } : {}),
  };
}

/**
 * 校验替代的两端仍可执行，为候选来历和旧枝剪除一起生成效果。
 * @param transaction 当前单树事务
 * @param candidate 被操作的替代候选
 * @param prune 旧枝的剪除理由及复活条件
 * @returns 同一条形成记录绑定的两条节点变化；不自动人确认
 */
async function planReplacement(
  transaction: WriteTransaction,
  candidate: CognitionNode,
  prune: Extract<BranchStateChange, { state: 'prune' }>,
): Promise<FormationPlan> {
  const { id, origin, state, parentId } = candidate;
  if (origin.kind !== 'replacement' || origin.status !== 'proposed') invalid('目标不是待执行的替代候选');
  if (state === 'prune' || state === undefined) invalid('替代候选必须有未被剪除的分支状态');
  const old = await requireNode(transaction, origin.replacesId);
  if (old.state === 'prune') invalid(`旧判断 ${old.id} 已被剪除`);
  if (id === old.id || parentId === null || old.parentId !== parentId) invalid('替代候选必须与旧判断同父');
  return {
    changes: [
      changeOrigin({ ...candidate, state }, { ...origin, status: 'applied' }),
      changeState(old, prune),
    ],
    action: {
      action: 'applyReplacement',
      reason: prune.pruneReason,
      reviveWhen: prune.reviveWhen,
      replacement: { oldId: old.id, newId: id },
    },
    summary: `执行替代：${id}「${candidate.body.title}」接替 ${old.id}「${old.body.title}」`,
  };
}
