/**
 * UI 使用的内核契约类型（只取类型）。
 *
 * 职责：把正式内核的领域契约（kernel/src/types）与操作目录的线协议（catalog/contracts）
 * 集中转出，供 UI 各层 import type。除这里的转出外，UI 不直接引用内核。
 * 边界：只 import type，不 import 内核运行时代码，也不认识宿主；UI 专有的视图派生状态
 *（例如由 confirmation + currentChange 派生的显示用确认程度）定义在 utils/labels，
 * 不写进领域类型。
 * 协作：kernel 的类型入口是唯一契约来源；原型替身内核的契约已退役，不再从这里转出。
 * 依据：docs/design/kernel-interfaces.md §3；docs/STRUCTURE.md 的依赖方向。
 */
import type {
  Boundary,
  Budget,
  BranchState,
  CognitionNode,
  Confirmation,
  ConfirmTarget,
  Decision,
  Depth,
  Draft,
  Expand,
  FormationDetail,
  FormationRevision,
  NodeDetail,
  NodeId,
  Origin,
  Page,
  PendingPage,
  PendingTarget,
  Placement,
  Ref,
  RefId,
  RefKind,
  RefTarget,
  Revision,
  RevisionActor,
  RevisionDetail,
  RevisionId,
  SeedTree,
  TreeId,
  TreeView,
  ViewNode,
} from '../../../kernel/src/types';
import type { OpInput, OpName, OpOutput } from '../../../kernel/src/catalog/contracts';

export type {
  Boundary,
  Budget,
  BranchState,
  CognitionNode,
  Confirmation,
  ConfirmTarget,
  Decision,
  Depth,
  Draft,
  Expand,
  FormationDetail,
  FormationRevision,
  NodeDetail,
  NodeId,
  OpInput,
  OpName,
  OpOutput,
  Origin,
  Page,
  PendingPage,
  PendingTarget,
  Placement,
  Ref,
  RefId,
  RefKind,
  RefTarget,
  Revision,
  RevisionActor,
  RevisionDetail,
  RevisionId,
  SeedTree,
  TreeId,
  TreeView,
  ViewNode,
};

/**
 * 读视图的焦点：稳定节点 ID，或显式选择树根。
 * 来自接口单 §3.2；不用“当前选中”之类 UI 状态代替调用方明示的焦点。
 */
export type Focus = NodeId | { root: true };
