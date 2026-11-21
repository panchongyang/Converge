/** §3.4 的原形成记录：只保存种子译出的事实，不应用历史明细或从中生成当前变更。 */
import type { EffectItem, NodeId, SeedHistoryEntry } from '../types';
import {
  branchState, confirmTarget, invalid, list, onlyFields, openOrKeep, optionalText, record, requiredText,
} from './validation';

/** 自举兼容的是原历史；新建树形成记录只由正常写入生成。 */
type ImportedDetail = NonNullable<SeedHistoryEntry['detail']>;
type ImportedFormationDetail = Extract<ImportedDetail, { action: string }>;

/**
 * 校验并复制一条原记录；保留时刻原精度、原出处与确有记载的明细。
 * @param value 种子中的原历史条目，不携新的修订 ID
 * @param nodes 种子内可关联的全部节点 ID
 * @returns 独立的历史条目；调用方按原行序编号
 */
export function seedHistoryEntry(value: unknown, nodes: ReadonlySet<NodeId>): SeedHistoryEntry {
  const data = record(value, '导入历史');
  onlyFields(data, ['kind', 'at', 'by', 'nodeIds', 'summary', 'source', 'detail'], '导入历史');
  if ((data.kind !== 'formation' && data.kind !== 'confirmation') || data.by !== 'import') {
    invalid('导入历史只能作为原形成或确认记录，并标为 import');
  }
  const nodeIds = Array.from(list(data.nodeIds, '导入历史关联节点'), (id) => seedNodeId(id, nodes));
  if (nodeIds.length === 0) invalid('导入历史至少关联一个种子节点');
  const entry: SeedHistoryEntry = {
    kind: data.kind,
    at: requiredText(data.at, '导入历史时间'),
    by: 'import',
    nodeIds,
    summary: requiredText(data.summary, '导入历史叙述'),
  };
  const source = optionalText(data.source, '导入历史原出处');
  if (source !== undefined) entry.source = source;
  if (data.detail !== undefined) entry.detail = importedDetail(data.detail, data.kind, nodes);
  return entry;
}

/**
 * 校验史料已经指明的关联节点，不能生成树外悬空节点关联。
 * @param value 史料中的节点 ID
 * @param nodes 种子内可关联的全部节点 ID
 * @returns 已存在于种子的稳定 ID
 */
function seedNodeId(value: unknown, nodes: ReadonlySet<NodeId>): NodeId {
  const id = requiredText(value, '导入历史关联节点 ID');
  if (!nodes.has(id)) invalid(`导入历史关联的节点 ${id} 不在种子中`);
  return id;
}

/**
 * 按原记录种类读取可选明细；历史确认仅作历史，不替人产生新确认或日常指针。
 * @param value 给出的原历史明细
 * @param kind 原记录的种类
 * @param nodes 种子内可关联的全部节点 ID
 * @returns 与原种类匹配的明细副本
 */
function importedDetail(value: unknown, kind: SeedHistoryEntry['kind'], nodes: ReadonlySet<NodeId>): ImportedDetail {
  const data = record(value, '导入历史明细');
  if (kind === 'confirmation') {
    onlyFields(data, ['target'], '导入确认明细');
    const target = confirmTarget(data.target);
    if (target.seedNodeId !== undefined) seedNodeId(target.seedNodeId, nodes);
    return { target };
  }
  const effects = Array.from(list(data.effects, '导入形成效果'), (item) => importedEffect(item, nodes));
  return importedFormation(data, effects, nodes);
}

/**
 * 复制已记载的效果，保留新节点缺少 beforeState 与原状态未载为 null 的区别。
 * @param value 给出的原效果项
 * @param nodes 种子内可关联的全部节点 ID
 * @returns 已校验的效果副本
 */
function importedEffect(value: unknown, nodes: ReadonlySet<NodeId>): EffectItem {
  const data = record(value, '导入形成效果项');
  onlyFields(data, ['nodeId', 'beforeState', 'afterState'], '导入形成效果项');
  const effect: EffectItem = { nodeId: seedNodeId(data.nodeId, nodes), afterState: branchState(data.afterState) };
  if (data.beforeState !== undefined) {
    effect.beforeState = data.beforeState === null ? null : branchState(data.beforeState);
  }
  return effect;
}

/**
 * 校验原形成明细的动作参数；史料未载明细须省略整个明细，不推断发生了何种动作。
 * @param data 原形成明细各字段
 * @param effects 已验证的原形成效果项
 * @param nodes 种子内可关联的全部节点 ID
 * @returns 原形成明细副本
 */
function importedFormation(
  data: Record<string, unknown>, effects: EffectItem[], nodes: ReadonlySet<NodeId>,
): ImportedFormationDetail {
  const action = data.action;
  switch (action) {
    case 'createTree':
      return invalid('日常新建树的形成记录不能由自举导入');
    case 'addBranch':
      onlyFields(data, ['action', 'effects'], '导入新增明细');
      return { action, effects };
    case 'prune':
      onlyFields(data, ['action', 'effects', 'reason', 'reviveWhen'], '导入剪除明细');
      return { action, effects, reason: requiredText(data.reason, '剪除理由'),
        reviveWhen: requiredText(data.reviveWhen, '复活条件') };
    case 'revive': {
      onlyFields(data, ['action', 'effects', 'state', 'reason', 'previousPrune'], '导入重新启用明细');
      const detail: ImportedFormationDetail = { action, effects, state: openOrKeep(data.state),
        reason: requiredText(data.reason, '重新启用理由') };
      if (data.previousPrune !== undefined) {
        const previous = record(data.previousPrune, '原剪除信息');
        onlyFields(previous, ['pruneReason', 'reviveWhen'], '原剪除信息');
        const pruneReason = optionalText(previous.pruneReason, '原剪除理由');
        const reviveWhen = optionalText(previous.reviveWhen, '原复活条件');
        detail.previousPrune = {
          ...(pruneReason !== undefined ? { pruneReason } : {}),
          ...(reviveWhen !== undefined ? { reviveWhen } : {}),
        };
      }
      return detail;
    }
    case 'setOpenOrKeep':
      onlyFields(data, ['action', 'effects', 'state', 'reason'], '导入留与未决明细');
      return { action, effects, state: openOrKeep(data.state), reason: requiredText(data.reason, '转换理由') };
    case 'applyReplacement': {
      onlyFields(data, ['action', 'effects', 'reason', 'reviveWhen', 'replacement'], '导入执行替代明细');
      const replacement = record(data.replacement, '历史替代关系');
      onlyFields(replacement, ['oldId', 'newId'], '历史替代关系');
      const oldId = seedNodeId(replacement.oldId, nodes);
      const newId = seedNodeId(replacement.newId, nodes);
      if (oldId === newId) invalid('历史替代关系必须指向不同的新旧判断');
      return {
        action, effects, reason: requiredText(data.reason, '剪除理由'),
        reviveWhen: requiredText(data.reviveWhen, '复活条件'), replacement: { oldId, newId },
      };
    }
    default:
      return invalid('导入历史包含不认识的形成明细');
  }
}
