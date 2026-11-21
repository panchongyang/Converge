/**
 * 操作目录的线协议：把接口单 §3 的位置参数命名，供适配器构造意图、UI 只取类型。
 * 状态归属：无。新建指定尚不存在的树 ID；其余日常操作针对已选择的树或实际读取结果。身份不属于 input。
 * 单个操作的业务约束留在领域契约及命令/查询，不在适配层建立第二套定义。
 */
import type {
  Budget, ConfirmTarget, Decision, Draft, Expand, NodeDetail, NodeId, Page, PendingPage,
  Placement, Revision, RevisionActor, RevisionId, SeedTree, TreeId, TreeView,
} from '../types';

/** 参数均由调用方明确给出；可省略项只用于首次读取或查询整棵树。 */
export interface OpInput {
  /** 人与 AI 都可新建空白树；不接收种子、历史或确认字段。 */
  createTree: {
    /** 尚未存在的工作区树 ID，也是这次创建的根节点 ID；不能是空白。 */
    treeId: TreeId;
    /** 根的问题文本，非空白，原样存为标题；根起始为未决、未经人确认。 */
    rootQuestion: string;
  };
  addBranch: { treeId: TreeId; placement: Placement; draft: Draft };
  decideNode: { treeId: TreeId; nodeId: NodeId; decision: Decision };
  confirm: { treeId: TreeId; target: ConfirmTarget };
  bootstrapTree: { seed: SeedTree };
  readView: {
    treeId: TreeId;
    /** 指定稳定节点 ID，或显式选择根；不根据选中状态猜测焦点。 */
    focus: NodeId | { root: true };
    expand: Expand;
    budget: Budget;
    onLimit: 'fold' | 'exact';
    /** 上一页的游标。续读仍须提供相同的树、范围和读取策略，预算按本页计。 */
    cursor?: string;
  };
  readNode: { treeId: TreeId; nodeId: NodeId };
  readHistory: { treeId: TreeId; nodeId?: NodeId; limit: number; after?: RevisionId };
  readUnconfirmed: { treeId: TreeId; by: RevisionActor[]; limit: number; after?: ConfirmTarget };
}

/** 写结果只在提交后兑现；返回稳定 ID 不表示人已确认。读结果来自所请求的快照。 */
export interface OpOutput {
  createTree: TreeId;
  addBranch: NodeId;
  decideNode: NodeId;
  confirm: RevisionId;
  bootstrapTree: TreeId;
  readView: TreeView;
  readNode: NodeDetail;
  readHistory: Page<Revision>;
  readUnconfirmed: PendingPage;
}

/** 仅开放目录声明的意图，不暴露事务句柄或任意字段更新。 */
export type OpName = keyof OpInput;
