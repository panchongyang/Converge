/**
 * 局部读取的契约：展开参数、预算、视图行、边界与结果分页。
 *
 * 职责：定义 readView 的输入参数和 TreeView 等返回形状，单位与完整性语义写在这里。
 * 边界：只描述结果，不含遍历、去重或预算实现；内核不认识宿主，读模型由 queries 完成。
 * 协作：只依赖 ids / actor / node-status / origin / ref 等底层类型文件（ref 再依赖 ref-target）；
 * ports 的 ReadSnapshot 提供 NodeRow（轻行）等分批读取；ui 只消费这些视图类型。
 */
import type { DailyActor } from './actor';
import type { NodeId, RevisionId } from './ids';
import type { BranchState, Confirmation } from './node-status';
import type { Origin } from './origin';
import type { Ref } from './ref';

/**
 * 展开深度，单位是边数。
 * 非负整数表示向下几层；'leaf' 表示显式请求直到叶子，仍受预算约束。没有暗中默认值。
 */
export type Depth = number | 'leaf';

/**
 * 从焦点折出一棵局部树的范围参数，全部由调用方显式给出。
 * 深度与跳数单位都是边数；沿树向下、补父链不消耗引用跳数。
 */
export interface Expand {
  /** 初始焦点向下的树深；0 只命中焦点，1 加直接子节点。 */
  subtreeDepth: Depth;
  /** 一条路径最多跨多少条树内引用边；非负整数，0 为纯子树。 */
  jumpHops: number;
  /** 引用方向：out 我指向谁、in 谁指向我、both 两个方向；结果始终保留边的原方向。 */
  direction: 'out' | 'in' | 'both';
  /** 起跳范围：anchor 仅本轮起点；expanded 还含本轮起点按深度展开的子节点。 */
  jumpFrom: 'anchor' | 'expanded';
  /** 每个引用落点再向下展开的深度；0 只命中落点，与 subtreeDepth 独立生效。 */
  afterJumpDepth: Depth;
}

/**
 * 一次读取的预算，三项都必须是正有限值；不接受“无限预算”。
 * 范围不等于预算：范围决定请求要覆盖到哪里，预算决定本次最多检查、返回和输出多少。
 */
export interface Budget {
  /** 本次实际检查的邻接行与查找次数（含空查、向前探一条、补父链）。 */
  maxScans: number;
  /** 返回节点数（命中与仅连接都算）。 */
  maxNodes: number;
  /** 序列化响应字节，含节点行、引用与边界标记。 */
  maxBytes: number;
}

/**
 * 轻行投影：只带遍历与绘制需要的字段，不含正文。
 *
 * 用途：ReadSnapshot 按 ID 或按父节点分批取行时用它，遍历不读长正文；
 * 需要标题、判断、依据或来源时再用 readNode 取完整节点。
 * 边界：hit / link 这类命中角色由 queries 在 ViewNode 上标，不属于存储行；
 * state 与 confirmation 省略表示手稿未载（不是 null），currentChange 只指向新写形成记录。
 */
export interface NodeRow {
  id: NodeId;
  /** 真实父节点；根为 null。引用不是第二父节点。 */
  parentId: NodeId | null;
  /** 节点标题（正文的 title）；完整正文不在这一行里。 */
  title: string;
  /** 当前分支状态；省略表示手稿未载，不是 null。 */
  state?: BranchState;
  /** 最近一次日常变更的指针；自举/导入且无日常变更时省略，执行者只能是 DailyActor。 */
  currentChange?: { revisionId: RevisionId; by: DailyActor };
  /** 当前确认程度；省略表示手稿未载，不是 null。 */
  confirmation?: Confirmation;
  origin: Origin;
}

/**
 * 视图里的一行节点：在轻行之上标出它为何在结果中。
 * 真实父节点必须给出，引用不是第二父节点。
 */
export interface ViewNode extends NodeRow {
  /** hit 落在请求范围内；link 只为把命中节点连回根而补入的祖先，其余孩子未读。 */
  role: 'hit' | 'link';
}

/**
 * 读取边界：标出遍历在哪个节点的哪个方向停下，以及为什么停下。
 *
 * 三个约定：
 * - scope：参数范围到此，没要求再查（深度、跳数、方向或起跳范围造成的边界）；
 * - exhausted：在本查询要求的范围内确实查尽，没有更多可读；
 * - budget：预算先到，此处还没读完，`TreeView.complete=false` 并附续读游标。
 * scope 与 exhausted 都不是预算用尽，也都不是结果断裂。
 *
 * 按 axis 的标法：
 * - children：标在孩子没有被继续读入的节点上。达到 subtreeDepth / afterJumpDepth 记 scope；
 *   已确认没有孩子可读记 exhausted；预算不够继续取孩子记 budget。
 * - refs：标在该方向没有继续跳的节点上。达到 jumpHops、direction 或 jumpFrom 的边界记 scope；
 *   已确认该方向没有更多引用（含外部材料目标）记 exhausted；预算不够继续取引用记 budget。
 *
 * 不用“没有标记”暗示 exhausted：范围内确实查尽时显式返回 exhausted。
 * AI 视图在 jumpHops=0 时不投影重复的 refs/scope；零跳数本身表示没有查询引用。
 */
export interface Boundary {
  nodeId: NodeId;
  /** children 子节点方向；refs 引用方向（按 expand.direction）。 */
  axis: 'children' | 'refs';
  /** scope 参数边界；exhausted 范围内查尽；budget 预算先到可续读。 */
  kind: 'scope' | 'exhausted' | 'budget';
}

/**
 * 一次 readView 的结果：一棵连通、有根的局部树，引用作为旁边的关联。
 * 每次成功返回都包含原根、焦点及连接所需的父链；剪枝、未确认不让结构断开。
 */
export interface TreeView {
  /** 真实树根；不是焦点。焦点可显式选根。 */
  rootId: NodeId;
  focusId: NodeId;
  /** 按稳定 ID 去重；每个节点的父链都在结果里。 */
  nodes: ViewNode[];
  /**
   * 按边 ID 去重：两个不同的引用即使碰到同一节点，仍是两条边。
   * 每条引用的 from 必在 nodes 中；树内目标的 nodeId 也必在 nodes 中；
   * 外部材料目标只返回定位符，不伪造目标节点。
   */
  refs: Ref[];
  boundaries: Boundary[];
  /** 本查询累计是否已覆盖请求范围；不是“本页含整棵树”。 */
  complete: boolean;
  /** 读取所基于的已提交版本；续读必须使用同一版本。 */
  stamp: number;
  /** 续读游标；只在预算先到、还有未完成遍历时给出。编码接口单未定，实现时再定。 */
  cursor?: string;
}

/**
 * 一页结果。items 从新到旧；next 是上一页末项对应的起点键，只在还有下一页时给出。
 * 历史分页的起点键是 RevisionId；未确认分页使用 decision.ts 的 PendingPage。
 */
export interface Page<T> {
  items: T[];
  next?: string;
}
