/**
 * 一次性自举的输入契约。
 *
 * 职责：描述适配器从手稿译出的目标树 ID、根、节点、引用与原历史；bootstrapTree 据此
 * 在一次事务里创建目标树。
 * 边界：不是日常读写单位；这里不含导入实现，也没有内核分配的修订 ID 与 currentChange 指针。
 * 历史里不含修订 ID（自举时由内核分配），节点沿用原 ID。
 * 协作：ports 的 TreeStore.transact(createNew) 承接；节点与引用复用 node / ref 的形状。
 */
import type { NodeId, TreeId } from './ids';
import type { CognitionNode } from './node';
import type { Ref } from './ref';
import type { CreateTreeDetail, ImportedRevision, RevisionDetail } from './revision';

/**
 * 种子节点：沿用原 ID 与原有的正文、状态、确认程度、来历与剪除信息。
 * 不含 currentChange——原历史还没有内核分配的修订 ID，自举节点没有日常变更指针。
 * 手稿未载的 state / confirmation 保持缺键。
 */
export type SeedNode = Omit<CognitionNode, 'currentChange'>;

/**
 * 一条原历史。数组顺序即原行序（不另设行号字段）；同一行同时含形成与确认时
 * 拆成两条，共用 source。每条都是导入记录（by 恒为 import），自举时内核分配修订 ID；
 * `at` 保留原时间精度，只有日期就写日期，不补午夜或导入时刻。自举不接受日常新建树的明细。
 */
export type SeedHistoryEntry = Omit<ImportedRevision, 'id' | 'detail'> & {
  detail?: Exclude<RevisionDetail, CreateTreeDetail>;
};

/** 一次性自举的输入；只在目标树不存在时使用，之后以产品数据为准。 */
export interface SeedTree {
  /** 目标树 ID；已存在时报 invalid，不覆盖。 */
  treeId: TreeId;
  /** 树根节点 ID；必须出现在 nodes 中且 parentId 为 null，由导入器校验（类型无法表达）。 */
  rootId: NodeId;
  /** 全部节点，沿用原 ID；导入不是确认，节点上的确认程度沿用导入值。 */
  nodes: SeedNode[];
  /** 原引用边，原样保留方向与目标；树内目标也要能在 nodes 中定位。 */
  refs: Ref[];
  /** 原历史，按原行序；每条导入后成为一条由内核编号的导入记录。 */
  history: SeedHistoryEntry[];
}
