/**
 * 已保存节点的领域契约。
 *
 * 职责：定义 CognitionNode——节点正文、当前分支状态、确认程度、来历与当前变更指针。
 * 边界：只描述已保存事实，不含读写实现，也不认识宿主。正文一经保存不可覆盖；
 * 手稿未载的分支状态或确认程度省略字段，不写 null。
 * 协作：只依赖 ids / actor / node-status / origin / node-body 这些叶类型；
 * revision 不反向引用它，read 的 NodeRow 是同一事实的轻行投影（不含正文）。
 */
import type { DailyActor } from './actor';
import type { NodeId, RevisionId } from './ids';
import type { NodeBody } from './node-body';
import type { BranchState, Confirmation } from './node-status';
import type { Origin } from './origin';

/**
 * 已保存的节点。
 * 节点行保存的是当前事实；历史变化留在修订记录里，不在这里重放。
 */
export interface CognitionNode {
  id: NodeId;
  /** 真实父节点；根为 null。引用不是第二个父节点。 */
  parentId: NodeId | null;
  /** 已保存正文；创建后不可覆盖。 */
  body: NodeBody;
  /** 当前分支状态；省略表示手稿未载（例如 T1.3“已有结论”），不用 null，也不猜一个值。 */
  state?: BranchState;
  /** 当前确认程度；省略表示手稿未载确认来源，不用 null。 */
  confirmation?: Confirmation;
  origin: Origin;
  /**
   * 该节点最近一次实际日常变更的形成记录指针，并带出执行者种类。
   * 自举/导入且没有日常变更的节点省略这一项，确认程度沿用导入值；
   * 执行者只能是 DailyActor，导入记录不会成为当前变更。
   */
  currentChange?: { revisionId: RevisionId; by: DailyActor };
  /** 当前剪除理由；仅在 state = 'prune' 时有意义，历史理由在修订记录里。 */
  pruneReason?: string;
  /** 当前复活条件；手稿未载时保持缺失，UI 显式标“未记录”，不要补造。 */
  reviveWhen?: string;
}
