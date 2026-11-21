/**
 * 修订记录的领域契约。
 *
 * 职责：定义一次形成、确认或导入留下的日志形状，包括执行者、时间、关联节点与结构化明细。
 * 边界：修订只追加、不改写；形成与确认不混同。新写的形成记录必须带完整明细，
 * 新写的确认记录只能由人执行；导入记录保留原出处与时间精度，事实不足不补造明细。
 * 协作：只依赖 ids / actor / node-status / confirm-target 这些叶类型；
 * node 的 currentChange 指向新写形成记录，node-detail 取它的全文，ports 的事务按 ID 读写。
 */
import type { DailyActor } from './actor';
import type { ConfirmTarget } from './confirm-target';
import type { NodeId, RevisionId } from './ids';
import type { BranchState } from './node-status';

/** 修订种类：formation 说明树如何长出、剪除、复活或替代；confirmation 只说明人确认。 */
export type RevisionKind = 'formation' | 'confirmation';

/**
 * 一条修订实际造成的单个节点状态效果。
 * 新节点省略 beforeState；原状态未载用 null（接口单明定）；afterState 是变更后的状态，总是可知。
 */
export interface EffectItem {
  nodeId: NodeId;
  /** 变更前状态；省略表示本次新建了该节点，null 表示原状态手稿未载。 */
  beforeState?: BranchState | null;
  /** 变更后状态。 */
  afterState: BranchState;
}

/** 重新启用时被换下的剪除理由与复活条件；缺项保持缺失，不补造。 */
export interface PreviousPrune {
  pruneReason?: string;
  reviveWhen?: string;
}

/** 新建树：只记根的新增效果，不是导入，也不带决定专用参数。 */
export interface CreateTreeDetail {
  action: 'createTree';
  /** 命令固定写一项：根 ID 等于树 ID，初始为 open，不填 beforeState。 */
  effects: EffectItem[];
  reason?: never;
  reviveWhen?: never;
  previousPrune?: never;
  replacement?: never;
  state?: never;
}

/** 新增分支：只记结构效果，不带任何决定专用参数。 */
export interface AddBranchDetail {
  action: 'addBranch';
  /** 受影响的节点状态；第一项是被操作的节点（这里就是新节点）。 */
  effects: EffectItem[];
  /** 决定专用字段不得出现在新增分支上；`?: never` 让多写的键无法通过类型检查。 */
  reason?: never;
  reviveWhen?: never;
  previousPrune?: never;
  replacement?: never;
  state?: never;
}

/** 剪除：保留节点、正文与引用，只改状态，并记录非空白理由与复活条件。 */
export interface PruneDetail {
  action: 'prune';
  /** 受影响的节点状态；第一项是被剪除的节点。 */
  effects: EffectItem[];
  /** 调用方给出的非空白剪除理由。 */
  reason: string;
  /** 调用方给出的非空白复活条件。 */
  reviveWhen: string;
  previousPrune?: never;
  replacement?: never;
  state?: never;
}

/** 重新启用：只对已剪节点，恢复为 keep 或 open，保留剪除历史。 */
export interface ReviveDetail {
  action: 'revive';
  /** 受影响的节点状态；第一项是被重新启用的节点。 */
  effects: EffectItem[];
  /** 明确选择的目标状态，只允许 keep 或 open。 */
  state: 'keep' | 'open';
  /** 调用方给出的非空白理由；只写日志，不回填正文。 */
  reason: string;
  /** 被换下的剪除理由与复活条件，含来自手稿的内容；缺项保持缺失。 */
  previousPrune?: PreviousPrune;
  reviveWhen?: never;
  replacement?: never;
}

/** 切换留与未决：只允许 keep ↔ open，或把分支状态未载的判断定为 keep / open。 */
export interface SetOpenOrKeepDetail {
  action: 'setOpenOrKeep';
  /** 受影响的节点状态；第一项是被操作的节点。 */
  effects: EffectItem[];
  /** 明确选择的目标状态，只允许 keep 或 open。 */
  state: 'keep' | 'open';
  /** 调用方给出的非空白理由。 */
  reason: string;
  reviveWhen?: never;
  previousPrune?: never;
  replacement?: never;
}

/** 执行替代：把候选标为 applied、剪掉旧判断，并记录新旧方向。 */
export interface ApplyReplacementDetail {
  action: 'applyReplacement';
  /** 同时列出旧判断（转为剪）与候选（分支状态前后相同，来历转为已执行）。 */
  effects: EffectItem[];
  /** 调用方给出的非空白理由。 */
  reason: string;
  /** 调用方给出的非空白复活条件。 */
  reviveWhen: string;
  /** oldId 是被剪的旧判断，newId 是转为已执行的替代候选。 */
  replacement: { oldId: NodeId; newId: NodeId };
  previousPrune?: never;
  state?: never;
}

/**
 * 形成记录的结构化明细，回答“这次到底改了什么”。
 * 按 action 判别：新建树、新增分支、剪除、重新启用、切换留/未决、执行替代；
 * effects 的第一项是被操作的节点。剪除与替代必记理由与复活条件，
 * 重新启用与切换必记目标状态与理由，新建树和新增分支不带决定专用字段。
 * 导入记录的事实不足时整个明细可缺（见 ImportedRevision），不在这里补造。
 */
export type FormationDetail =
  | CreateTreeDetail
  | AddBranchDetail
  | PruneDetail
  | ReviveDetail
  | SetOpenOrKeepDetail
  | ApplyReplacementDetail;

/**
 * 确认记录的结构化明细：只标明被确认的对象，不复制正文或状态。
 * target 二选一，语义见 ConfirmTarget。
 */
export interface ConfirmationDetail {
  target: ConfirmTarget;
}

/**
 * 修订明细：形成记录带 action 与 effects，确认记录带 target。
 * 调用方按 Revision 的具体分支判断该读哪一支；导入记录可能没有明细。
 */
export type RevisionDetail = FormationDetail | ConfirmationDetail;

/** 三种修订共有的定位与叙述字段；id 由模型在写事务内分配。 */
interface RevisionBase {
  id: RevisionId;
  /**
   * 实际发生时刻。新写入为含时区偏移的 ISO 8601 时刻；
   * 导入记录沿用原时间精度（例如只有日期），不补午夜或导入时刻。
   */
  at: string;
  /** 至少一个稳定节点 ID；补充、勘误的父节点可列入供回查，但它不算 effects、不改确认标记。 */
  nodeIds: NodeId[];
  /** 面向人的一句话叙述。 */
  summary: string;
  /** 导入记录的原出处，例如“认知树.md 形成记录 #8”；新写入通常省略。 */
  source?: string;
}

/** 新写的形成记录：执行者是日常变更者，结构化明细必须完整。 */
export interface FormationRevision extends RevisionBase {
  kind: 'formation';
  /** 执行者由可信入口识别，只能是人和 AI。 */
  by: DailyActor;
  detail: FormationDetail;
}

/** 新写的确认记录：只有人能确认；明细只标被确认的目标，不复制正文或状态。 */
export interface ConfirmationRevision extends RevisionBase {
  kind: 'confirmation';
  /** 确认只能由人发起；AI 或自报 human 都不能获得确认。 */
  by: 'human';
  detail: ConfirmationDetail;
}

/**
 * 导入记录：自举时按原历史追加，执行者恒为 import，明细可缺。
 * 手稿事实不足时不补造明细；kind 仍标明这条原记录是形成还是确认，
 * 有明细时应与 kind 相配（形成对 FormationDetail，确认对 ConfirmationDetail），
 * 这条语义由导入器按原记录保证，不靠类型收窄——导入事实可能不完整。
 */
export interface ImportedRevision extends RevisionBase {
  kind: RevisionKind;
  by: 'import';
  detail?: RevisionDetail;
}

/**
 * 一条追加的修订，按来源分为三个互斥分支：
 * 新写的形成记录、新写的确认记录、导入记录。
 * 只有改变认知的写入才产生修订；阅读、展开、折叠不写时间线。
 */
export type Revision = FormationRevision | ConfirmationRevision | ImportedRevision;
