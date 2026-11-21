/**
 * 稳定 ID 别名。
 *
 * 职责：定义树、节点、引用边与修订四类标识的类型；分配者与生命周期写在每个别名上。
 * 边界：只有字符串别名，不含排序、解析或分配实现；ID 的自然序比较在 utils/compare-ids。
 * 协作：node、revision、decision、read 等主题文件都从这里取 ID，彼此不互相引用。
 */

/** 树 ID：工作区内一棵树的稳定标识，例如 "T1"。新建时显式指定，其他日常操作由入口选择。 */
export type TreeId = string;

/** 节点 ID：树内唯一、稳定、不复用。新建树的根沿用树 ID，自举沿用手稿 ID，其余新增由模型分配。 */
export type NodeId = string;

/** 引用边 ID：每条边一个；两个不同的引用即使端点相同也是两条边。新引用的 ID 由模型分配。 */
export type RefId = string;

/**
 * 修订 ID：一条修订日志的稳定标识，由模型在写事务内分配。
 * 自举导入的历史由内核在导入事务内重新分配修订 ID；原行序与原出处保留在
 * SeedTree.history 的数组顺序和 source 字段里，不靠 ID 承载。
 */
export type RevisionId = string;
