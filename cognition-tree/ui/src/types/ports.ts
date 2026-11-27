/**
 * UI 内核的端口：UI 只经这里接触环境（接口单 3.3 的 CognitionClient / HostBridge）。
 *
 * - CognitionClient：认知读写，只暴露人侧操作，不传 actor（由入口识别）。
 * - TreeChange：UI 端口专有的提交后通知；它不是领域类型，内核契约里没有它。
 * - HostBridge：宿主导航等环境能力，全部可选；宿主做不到时 UI 退回显示出处文本。
 * - DockContext：给环境专属开发坞（例如浏览器的 AI 模拟器）的只读上下文。
 *
 * 浏览器适配层实现这些端口；DSH 客户端另行实现。UI 不直接 fetch、不读宿主全局量，
 * 也不 import 适配层或内核的运行时代码，只经 types/kernel.ts 取内核契约的类型。
 */
import type { ReactNode } from 'react';
import type {
  NodeId,
  OpInput,
  OpOutput,
  Revision,
  SeedTree,
  TreeId,
  ViewNode,
} from './kernel';

/**
 * 人侧可调用的操作。
 * AI 入口不在此列：UI 里没有“以 AI 身份写”的调用点，actor 由环境按入口固定。
 * readUnconfirmed 只取人待确认的 [ai, import] 索引，不做全树缓存统计。
 */
export type HumanOp =
  | 'createTree'
  | 'addBranch'
  | 'decideNode'
  | 'confirm'
  | 'bootstrapTree'
  | 'readView'
  | 'readNode'
  | 'readHistory'
  | 'readUnconfirmed';

/**
 * 一次提交后的变化通知（UI 端口的增补，见 docs/design/ux.md §6.2）。
 *
 * 为什么在 UI 端口而不在领域：这是宿主推送通道的形状，内核只保证提交成功后通知一次；
 * 领域契约不定义 UI 的刷新方式。revisions 用于播放到达 / 确认 / 剪除等过渡。
 */
export interface TreeChange {
  treeId: TreeId;
  /** 提交后的新版本；UI 据此读回，不本地猜测提交结果。 */
  stamp: number;
  /** 本次提交新增的修订，从旧到新。 */
  revisions: Revision[];
  /**
   * 只表示这次提交改变了可见集合（归档/恢复），不携带被隐藏的节点 ID。
   * UI 必须丢弃已读缓存并重读，否则搜索与阅读栏会继续显示已归档的内容。
   */
  visibilityChanged?: true;
}

/** UI 访问认知数据的唯一通道。 */
export interface CognitionClient {
  /**
   * 调用一项人侧操作。
   * @param op 操作名
   * @param input 该操作的输入；树 ID、焦点和目标都来自 UI 当前状态与人的明确操作
   * @returns 成功时的输出；写操作成功表示已提交（返回稳定 ID），不表示已由人确认
   * @throws 带 code 的业务错误（missing / invalid / storage / rangeTooLarge / viewExpired），UI 按 code 呈现
   */
  call<K extends HumanOp>(op: K, input: OpInput[K]): Promise<OpOutput[K]>;
  /**
   * 订阅树变化。
   * @param treeId 要观察的树
   * @param listener 每次写事务提交成功后调用一次，参数里带本次新增的修订
   * @returns 取消订阅的函数；组件卸载时必须调用
   */
  watch(treeId: TreeId, listener: (change: TreeChange) => void): () => void;
}

/** 宿主能力。每一项都可缺省，UI 必须能在缺省时退化而不影响树数据。 */
export interface HostBridge {
  /**
   * 打开外部依据（研究材料、实验结论等）。
   * @param target doc 为仓库相对路径；part 指出材料里的局部（例如 “E02”），缺省指整份材料
   * @returns 宿主完成导航时兑现；失败只影响这次打开，不改树
   */
  openSource?(target: { doc: string; part?: string }): Promise<void>;
}

/**
 * 工作区的树入口：按已知 ID 打开/切换，或由人新建一棵树。
 *
 * UI 只经这两个调用换树；没有列表、改名或删除。打开/创建的落点与工作区由环境按当前
 * 会话决定，UI 不传路径，也不把树 ID 带到别的会话。两个调用失败时都应抛出带 code 的
 * 业务错误（见 utils/errors），由入口把原因显示给人。
 */
export interface TreeAccess {
  /**
   * 打开一棵已知树，并让当前入口重新绑定到它。
   * 环境须先核对树的根（DSH 端用 readView({root:true})），不能靠“根 ID 等于树 ID”或
   * readNode(treeId) 推定旧库的根；树不存在时抛出 missing。
   * @param treeId 人明确输入的树 ID
   */
  open(treeId: TreeId): Promise<void>;
  /**
   * 由人新建一棵空树；成功后返回树 ID（新根节点 ID 与树 ID 相同）。
   * 同名不覆盖：目标已存在时抛出业务错误，不修改已有树。
   * @param treeId 尚未存在的树 ID
   * @param rootQuestion 根问题原文，非空白
   * @returns 创建出的树 ID
   */
  create(treeId: TreeId, rootQuestion: string): Promise<TreeId>;
}

/**
 * 一项已归档的认知：整棵树没有 nodeId，显式归档的分支有 nodeId。
 * 归档只隐藏子树、不删数据；恢复后仍按显式标记嵌套隐藏。
 */
export interface ArchiveItem {
  /** 归档项所属的树 ID。 */
  treeId: TreeId;
  /** 显式归档的分支节点；缺省表示整棵树已归档。 */
  nodeId?: NodeId;
  /** 归档时的判断标题，只用于列表显示，不作为定位符。 */
  title: string;
}

/** 一次归档或恢复的目标；没有 nodeId 表示整棵树。 */
export interface ArchiveTarget {
  treeId: TreeId;
  nodeId?: NodeId;
}

/**
 * 归档端口：环境（DSH）实现同源请求；独立浏览器样例不提供，UI 也不渲染归档入口。
 * 列表与修改都以服务端读回为准，UI 不在提交前改动可见性。
 */
export interface ArchiveAccess {
  /**
   * 列出可恢复的归档项。
   * @param treeId 省略时只列整棵已归档的树；给定时列该活动树里显式归档的分支
   */
  list(treeId?: TreeId): Promise<ArchiveItem[]>;
  /**
   * 归档一项：没有 nodeId 时归档整棵树，有 nodeId 时隐藏该判断及其整个子树。
   * @param target 要归档的目标；成功返回时服务端已提交
   */
  archive(target: ArchiveTarget): Promise<void>;
  /**
   * 恢复一项：整树恢复，或恢复一个显式归档的分支；嵌套标记保持原样。
   * @param target 要恢复的目标
   */
  restore(target: ArchiveTarget): Promise<void>;
}

/** 开发坞拿到的只读上下文：知道人正在看哪里，但不能绕过 UI 写树。 */
export interface DockContext {
  treeId: TreeId;
  /** 人当前选中的节点；没有选中时为 null。 */
  selectedId: NodeId | null;
  /** UI 已读到的节点行（按 ID）。 */
  nodes: ReadonlyMap<NodeId, ViewNode>;
  /** 让 UI 选中并飞向某个节点。 */
  select(id: NodeId): void;
}

/** 应用壳的装配参数：环境只在这里把端口和环境专属内容交给 UI。 */
export interface AppProps {
  treeId: TreeId;
  /** 打开页面时从哪个判断开始读；省略时从根开始。不改变树、不表示确认。 */
  initialNodeId?: NodeId;
  client: CognitionClient;
  bridge: HostBridge;
  /**
   * 工作区的树入口（打开已知树 / 新建树）。给了它，空状态与顶栏都只提供这一个入口；
   * 不给时保持独立浏览器样例的 bootstrap 入口。两者不同时出现，避免一个环境有两种建树方式。
   */
  trees?: TreeAccess;
  /**
   * 树内左上角返回“全部树”列表的入口。给了它，宿主把“全部树”当作树的上级视图：
   * 顶栏显示返回入口，空状态也只提示返回；独立浏览器样例不提供，保持原样。
   */
  onBackToTrees?: () => void;
  /**
   * 归档与恢复端口。给了它，阅读栏才出现「归档」并在顶栏提供「已归档」；
   * 不给时（独立浏览器样例）不渲染任何归档入口。
   */
  archive?: ArchiveAccess;
  /**
   * 树不存在时由人发起的一次性样例导入（独立浏览器测试专用）；不给则空状态没有导入。
   * DSH 工作区面板不提供它，运行时也不 import 任何手稿或样例数据。
   */
  bootstrap?: { label: string; describe: string; seed: () => SeedTree };
  /** 环境专属的开发坞（浏览器里是 AI 模拟器与开发面板）；UI 只给位置和只读上下文。 */
  renderDock?: (ctx: DockContext) => ReactNode;
}
