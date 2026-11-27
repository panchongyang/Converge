/**
 * 人的一次写入 → 正式内核操作（纯映射）。
 *
 * 职责：把阅读栏里能发起的几类动作翻译成 catalog 的操作输入；提供确认目标的判定。
 * 边界：不提交、不改缓存；确认目标只从读到的节点事实推导，不由异步分页或“最新节点”顶替。
 * 协作：Inspector 组装意图，useHumanWrite 提交；Vitest 直接验证这些映射。
 * 依据：docs/design/kernel-interfaces.md §3.1（addBranch / decideNode / confirm）。
 */
import type {
  BranchState,
  CognitionNode,
  ConfirmTarget,
  Decision,
  Draft,
  NodeDetail,
  NodeId,
  Placement,
} from '../types/kernel';

/** 新的同级/子判断关系；界面不提供登记替代候选，替代只由比较后执行。 */
export type BranchRelation = 'branch' | 'supplement' | 'erratum';

/** 人在阅读栏能发起的一次写入；三类操作分开映射到内核操作，不合并语义。 */
export type HumanWrite =
  /** 日常决定：剪除 / 重新启用 / 切换留与未决 / 执行替代。 */
  | { kind: 'decision'; decision: Decision }
  /** 确认一条已读到的形成记录，或一个仍无日常变更的导入判断。 */
  | { kind: 'confirm'; target: ConfirmTarget }
  /** 在所属判断下新增子判断 / 补充 / 勘误，原正文不改。 */
  | { kind: 'addBranch'; parentId: NodeId; relation: BranchRelation; draft: Draft };

/**
 * 剪除：保留节点与正文，记理由与复活条件。
 * @param reason 非空白理由
 * @param reviveWhen 非空白复活条件
 */
export function pruneDecision(reason: string, reviveWhen: string): Decision {
  return { type: 'prune', reason, reviveWhen };
}

/**
 * 重新启用已剪判断。
 * @param state 恢复为留或未决
 * @param reason 非空白理由
 */
export function reviveDecision(state: 'keep' | 'open', reason: string): Decision {
  return { type: 'revive', state, reason };
}

/**
 * 在留与未决之间切换，或把状态未载的判断定为留 / 未决。
 * @param state 目标状态
 * @param reason 非空白理由
 */
export function switchDecision(state: 'keep' | 'open', reason: string): Decision {
  return { type: 'setOpenOrKeep', state, reason };
}

/**
 * 执行替代：把候选标为已执行、剪掉旧判断；不表示人已确认。
 * @param reason 剪去旧判断的理由
 * @param reviveWhen 旧判断的复活条件
 */
export function replacementDecision(reason: string, reviveWhen: string): Decision {
  return { type: 'applyReplacement', reason, reviveWhen };
}

/**
 * 新判断草稿；正文一经保存不可覆盖。
 * @param title 判断标题
 * @param text 可选展开内容；空串不写
 * @param state 初始分支状态
 */
export function addBranchDraft(title: string, text: string, state: BranchState): Draft {
  return { body: text ? { title, text } : { title }, state, refs: [] };
}

/**
 * 新判断落点。
 * @param parentId 挂到哪个判断下
 * @param relation 普通子判断 / 补充 / 勘误
 */
export function addBranchPlacement(parentId: NodeId, relation: BranchRelation): Placement {
  return { parentId, kind: relation };
}

/**
 * 确认目标：只认读到的节点事实。
 *
 * - 已人确认 → 没有可确认的目标；
 * - 有当前形成记录 → 绑定这条明确的 revisionId（优先 readNode 带回的全文，其次节点指针）；
 * - 没有日常变更的导入判断 → 绑定节点本身；确认未载的导入判断允许人显式补记。
 * @param detail readNode 的结果；没有读到时为 null
 */
export function confirmTargetOf(detail: NodeDetail | null): ConfirmTarget | null {
  if (!detail || detail.confirmationUnavailable) return null;
  const node = detail.node;
  if (node.confirmation === 'humanConfirmed') return null;
  if (detail.currentChange) return { revisionId: detail.currentChange.id };
  if (node.currentChange) return { revisionId: node.currentChange.revisionId };
  return { seedNodeId: node.id };
}

/** 便于确认控件判断“是否还能确认”的节点字段子集。 */
export type ConfirmableNode = Pick<CognitionNode, 'id' | 'confirmation' | 'currentChange'>;
