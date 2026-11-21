/**
 * 领域值到界面文案与视觉语义的映射（纯数据）。
 *
 * 一个节点同时显示分支状态与确认程度，两者独立：“剪 · 人确认”只说明人确认了排除，
 * “留 · AI 提出”不表示人已同意（见 docs/glossary.md）。颜色只作强化，形状和文字是主编码。
 *
 * 确认程度是显示用的派生值，不落库：领域里只有 confirmation（未确认 / 人确认）与
 * currentChange.by（谁执行了这次变更）。“AI 提出”表示当前变更是 AI 执行且尚未经人确认；
 * 人执行但未确认的变更显示“未确认”，不用旧原型的 aiProposed 字段冒充领域事实。
 */
import type {
  BranchState,
  CognitionNode,
  FormationDetail,
  Origin,
  RefKind,
  Revision,
  RevisionActor,
} from '../types/kernel';

export const STATE_LABEL: Record<BranchState, string> = { keep: '留', prune: '剪', open: '未决' };

/**
 * 显示用的确认程度：
 * - humanConfirmed 人确认；
 * - proposed 当前变更是 AI 执行、尚未经人确认（由 confirmation + currentChange 派生）；
 * - unconfirmed 当前变更尚未经人确认（人执行或导入待确认）；
 * - null 确认未载（手稿没有记录确认来源）。
 */
export type ConfirmationView = 'humanConfirmed' | 'proposed' | 'unconfirmed' | null;

export const CONFIRMATION_LABEL: Record<Exclude<ConfirmationView, null>, string> = {
  humanConfirmed: '人确认',
  proposed: 'AI 提出',
  unconfirmed: '未确认',
};

/** 派生显示用的确认程度；只读节点上已有的领域字段，不修改也不写回。 */
export function confirmationView(node: Pick<CognitionNode, 'confirmation' | 'currentChange'>): ConfirmationView {
  if (node.confirmation === 'humanConfirmed') return 'humanConfirmed';
  if (node.confirmation !== 'unconfirmed') return null;
  return node.currentChange?.by === 'ai' ? 'proposed' : 'unconfirmed';
}

/** 当前变更是否由 AI 执行且尚未经人确认（列表里只标这一种例外）。 */
export function isAiProposed(node: Pick<CognitionNode, 'confirmation' | 'currentChange'>): boolean {
  return confirmationView(node) === 'proposed';
}

/**
 * 分支状态的文案；手稿未载时明说未载，不猜。
 * @param state 节点的分支状态；null / undefined 都表示手稿未载
 */
export function stateLabel(state: BranchState | null | undefined): string {
  return state ? STATE_LABEL[state] : '状态未载';
}

/**
 * 确认程度的文案；手稿未载时明说未载。
 * @param c 显示用的确认程度（见 confirmationView）
 */
export function confirmationLabel(c: ConfirmationView): string {
  return c ? CONFIRMATION_LABEL[c] : '确认未载';
}

/**
 * 节点来历的短文案；普通分支返回 null（不额外标注）。
 * @param origin 节点来历
 */
export function originLabel(origin: Origin): string | null {
  switch (origin.kind) {
    case 'branch':
      return null;
    case 'supplement':
      return '补充';
    case 'erratum':
      return '勘误';
    case 'replacement':
      return origin.status === 'applied' ? '已接替 ' + origin.replacesId : '拟替代 ' + origin.replacesId;
  }
}

/** 节点来历的单字徽记，用在空间视图的小标上。 */
export function originMark(origin: Origin): string | null {
  switch (origin.kind) {
    case 'branch':
      return null;
    case 'supplement':
      return '补';
    case 'erratum':
      return '勘';
    case 'replacement':
      return '替';
  }
}

/** 引用类型：名称、短名、它回答的问题。 */
export const REF_KIND: Record<RefKind, { label: string; short: string; question: string }> = {
  premise: { label: '依赖前提', short: '前提', question: '前提变了，哪些判断要复查' },
  example: { label: '同类实例', short: '实例', question: '另一处同一原则或失效模式' },
  conflict: { label: '与事实冲突', short: '冲突', question: '与外部可指认的事实不一致（只标记，不裁决）' },
};

/**
 * 引用局部的名称。part 在领域里保持自由字符串（接口单未列举取值），
 * 这里只给常见取值配文案，未知取值原样显示。
 */
export const PART_LABEL: Record<string, string> = {
  pruneReason: '剪除理由',
  reviveWhen: '复活条件',
  basis: '依据',
  text: '内容',
};

/** @param part 引用目标的局部；省略指整体 */
export function partLabel(part: string | undefined): string | null {
  if (!part) return null;
  return PART_LABEL[part] ?? part;
}

/** 时间线动作：形成明细的 action，或其种类；导入记录可能只有种类。 */
export type RevisionAction = FormationDetail['action'] | 'confirmation' | 'formation';

export const ACTION_LABEL: Record<FormationDetail['action'], string> = {
  createTree: '创建树',
  addBranch: '新增分支',
  prune: '剪除',
  revive: '重新启用',
  setOpenOrKeep: '改为留 / 未决',
  applyReplacement: '执行替代',
};

/**
 * 修订在时间线上的动作。
 * @param r 修订
 */
export function revisionAction(r: Revision): RevisionAction {
  if (r.kind === 'confirmation') return 'confirmation';
  return r.detail && 'action' in r.detail ? r.detail.action : 'formation';
}

/**
 * 修订动作的文案。新增分支按执行者区分：AI 的增补显示“AI 提出”，
 * 人的增补显示“人新增分支”（是分支、补充还是勘误看节点来历，不由修订记录猜）。
 * @param r 修订
 */
export function revisionActionLabel(r: Revision): string {
  if (r.kind === 'confirmation') return '人确认';
  if (r.by === 'import') return '导入记录';
  const d = r.detail;
  if (d && 'action' in d) {
    if (d.action === 'addBranch') return r.by === 'ai' ? 'AI 提出' : '人新增分支';
    return ACTION_LABEL[d.action];
  }
  return '导入记录';
}

/** 修订执行者的文案；领域只记种类，不记显示名。 */
export function revisionActorLabel(by: RevisionActor): string {
  return by === 'human' ? '人' : by === 'ai' ? 'AI' : '导入';
}

/** 形成明细里的理由；确认记录没有理由。 */
export function detailReason(r: Revision): string | undefined {
  return r.detail && 'reason' in r.detail ? r.detail.reason : undefined;
}

/** 形成明细里的复活条件；不属于该动作时返回 undefined。 */
export function detailReviveWhen(r: Revision): string | undefined {
  return r.detail && 'reviveWhen' in r.detail ? r.detail.reviveWhen : undefined;
}

/** 重新启用时被换下的旧剪除理由与复活条件。 */
export function detailPrevious(r: Revision): { pruneReason?: string; reviveWhen?: string } | undefined {
  return r.detail && 'previousPrune' in r.detail ? r.detail.previousPrune : undefined;
}

/**
 * 修订时间的显示：只有日期的手稿精度只显示日期（不补午夜）；精确时刻显示到秒。
 * @param r 修订
 */
export function formatAt(r: Pick<Revision, 'at'>): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.at)) return r.at + '（按日）';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(r.at);
  if (!m) return r.at;
  return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];
}

/**
 * 截断标题以适合空间视图的标签；按字符计（中文一个字一个字符）。
 * @param title 完整标题
 * @param max 最多保留的字符数
 */
export function clip(title: string, max: number): string {
  const chars = Array.from(title);
  return chars.length <= max ? title : chars.slice(0, max - 1).join('') + '…';
}

/**
 * 估算一行文字在 SVG 里的宽度（不量 DOM）：中日韩字符按 1em，其余按 0.58em。
 * @param text 文字
 * @param fontSize 字号（px）
 */
export function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp > 0x2e80 ? fontSize : fontSize * 0.58;
  }
  return w;
}
