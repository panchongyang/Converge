/**
 * 写入意图与待确认目标的契约。
 *
 * 职责：描述新节点草稿、落点、四种日常决定，以及确认目标与其分页结果。
 * 边界：这些类型只表达调用方交给内核的意图和读回的目标，不含校验与写入实现；
 * 确认只能由人发起，决定不自动获得人确认。
 * 协作：只依赖 ids / actor / node-body / node-status / ref-target / confirm-target 这些叶类型；
 * ports 的未确认索引返回 PendingTarget，revision 的 ConfirmationDetail 引用 ConfirmTarget。
 */
import type { RevisionActor } from './actor';
import type { ConfirmTarget } from './confirm-target';
import type { NodeId, RevisionId } from './ids';
import type { NodeBody } from './node-body';
import type { BranchState } from './node-status';
import type { RefKind, RefTarget } from './ref-target';

/**
 * 新节点草稿：只描述一个新节点，不能设置确认标记，也不能覆盖已有数据。
 * 初始状态必传；无引用时 refs 传 []；若初始为剪，pruneReason 与 reviveWhen 均须非空白，
 * 并随形成记录一并保存。新节点与引用的 ID 由模型在写事务内分配，from 由新节点决定。
 */
export interface Draft {
  body: NodeBody;
  /** 新节点的初始分支状态；没有缺省。 */
  state: BranchState;
  /** 新节点发出的引用；只有边类型与目标，引用 ID 和起点由模型补齐。 */
  refs: { kind: RefKind; target: RefTarget }[];
  /** 初始为剪时的剪除理由；非空白，随形成记录保存。 */
  pruneReason?: string;
  /** 初始为剪时的复活条件；非空白，缺项不补造。 */
  reviveWhen?: string;
}

/**
 * 新节点落点，二选一：
 * 指定父节点并说明是普通分支、补充还是勘误；或指定拟替代的旧节点。
 * 替代候选挂在旧节点的真实父节点下（同级）；根没有同级，不可被替代。
 * 两个变体用 `?: never` 互斥，不能既给父节点又给被替代节点。
 */
export type Placement =
  | {
      /** 新节点的真实父节点。 */
      parentId: NodeId;
      /** 与父节点的关系；决定来历是 branch / supplement / erratum。 */
      kind: 'branch' | 'supplement' | 'erratum';
      /** 指定被替代旧节点与指定父节点互斥。 */
      replacesId?: never;
    }
  | {
      /** 拟替代的旧节点 ID；新节点挂在它的真实父节点下。 */
      replacesId: NodeId;
      /** 替代候选不另给父节点，由旧节点决定。 */
      parentId?: never;
      kind?: never;
    };

/**
 * 人或 AI 对一个节点的决定（decideNode 的 decision）。四种动作名即 type，其余字段为参数。
 * reason、reviveWhen 均须非空白且无缺省；state 是调用方明确选择的目标状态。
 * 每种动作的适用条件由 commands 在写事务内校验；不适用报 invalid。
 */
export type Decision =
  | {
      /** 剪除：非根且尚未剪除；保留节点、正文和引用，只改状态并记录理由与复活条件。 */
      type: 'prune';
      reason: string;
      reviveWhen: string;
    }
  | {
      /** 重新启用：只对已剪节点；恢复为 keep 或 open，保留剪除历史。 */
      type: 'revive';
      state: 'keep' | 'open';
      reason: string;
    }
  | {
      /** 切换留与未决：只允许 keep ↔ open，或把状态未载的判断定为 keep / open。 */
      type: 'setOpenOrKeep';
      state: 'keep' | 'open';
      reason: string;
    }
  | {
      /**
       * 执行替代：nodeId 指未剪、尚未执行的替代候选，其旧判断仍未被剪且两者同父。
       * 一次提交把候选标为 applied、剪掉旧判断，并记录新旧 ID；旧原文与引用不动。
       * 执行不需要人的确认。
       */
      type: 'applyReplacement';
      reason: string;
      reviveWhen: string;
    };

/**
 * 待确认列表的一项，可直接交给 confirm，二选一：
 * revisionId 变体是尚未确认、且仍是至少一个节点 currentChange 的形成记录；
 * seedNodeId 变体是没有日常变更、导入时确认程度为 unconfirmed 的判断。
 * 两个变体用 `?: never` 互斥，`{revisionId, title}` 这类混合对象无法通过类型检查。
 */
export type PendingTarget =
  | {
      /** 形成记录 ID；其执行者种类按 RevisionActor 记录。 */
      revisionId: RevisionId;
      /** 形成记录发生时刻，含时区或沿用导入精度。 */
      at: string;
      /** 形成记录的执行者种类；筛选参数允许 import，它用于导入判断，不会成为 currentChange。 */
      by: RevisionActor;
      summary: string;
      /** 只列仍指向该形成记录的节点。 */
      nodeIds: NodeId[];
      /** 导入判断目标才用 title，与形成记录目标互斥。 */
      seedNodeId?: never;
      title?: never;
    }
  | {
      /** 导入判断的节点 ID。 */
      seedNodeId: NodeId;
      /** 导入判断的标题。 */
      title: string;
      /** 形成记录目标的字段都不得出现在导入判断上。 */
      revisionId?: never;
      at?: never;
      by?: never;
      summary?: never;
      nodeIds?: never;
    };

/**
 * 待确认列表的一页。items 按接口单顺序（形成记录从新到旧，导入判断排在其后按节点 ID）；
 * next 是上一页末项对应的 ConfirmTarget，只在还有下一页时给出。
 */
export interface PendingPage {
  items: PendingTarget[];
  next?: ConfirmTarget;
}
