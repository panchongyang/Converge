/**
 * 内核端口：树存储、只读快照与时钟。
 *
 * 职责：只给签名，不给实现。内核通过这两个端口接触持久化与时间；适配器负责绑定工作区、
 * 开事务、建索引并翻译宿主错误，业务规则不进入存储实现。
 * 边界：端口不接收裸 SQL、不暴露 Node/浏览器 API，也不拥有窗口或文件句柄。
 * 协作：models 调 TreeStore.transact 写，queries 调 openRead 读；commands 每次产生新记录时
 * 只取一次 Clock.now()，同笔修订共享。
 *
 * 接口单 3.3 对分页键与写事务句柄只写了职责，没给逐项签名；下面的形状取满足职责的最小集，
 * 并逐处标注“接口单未定，实现时再定”。这些标注处不是已批准的最终实现约束。
 */
import type { RevisionActor } from './actor';
import type { ConfirmTarget } from './confirm-target';
import type { PendingTarget } from './decision';
import type { NodeId, RefId, RevisionId, TreeId } from './ids';
import type { CognitionNode } from './node';
import type { NodeRow } from './read';
import type { Ref } from './ref';
import type { Revision } from './revision';

/**
 * 写事务内的句柄：同一单树事务里按 ID 读取相关行、按确认目标查重、写入明示变更并追加修订。
 * 接口单未定它的逐项形状，这里只列 3.3 明确要求的能力；实现时再定。
 * 事务提交后才兑现写入，work 抛错时全部回滚。正文不可覆盖、变更必须带修订等不变量由 models
 * 与 commands 守，端口本身不做业务校验。
 */
export interface WriteTransaction {
  /**
   * 按 ID 读完整节点行，供校验当前状态与正文。
   * @param nodeId 目标节点
   * @returns 节点；不存在时为 null
   */
  readNode(nodeId: NodeId): Promise<CognitionNode | null>;

  /**
   * 按 ID 读目标修订，供确认与替代核对。
   * @param revisionId 目标修订
   * @returns 修订；不存在时为 null
   */
  readRevision(revisionId: RevisionId): Promise<Revision | null>;

  /**
   * 按确认目标查重：该目标是否已有确认记录。
   * @param target 二选一的确认目标
   * @returns 已有确认时为 true
   */
  hasConfirmation(target: ConfirmTarget): Promise<boolean>;

  /**
   * 写入一条明示变更后的节点行：新节点插入，已有节点只允许改状态、确认程度、
   * 当前变更指针与替代来历；正文不可覆盖由调用方保证。
   * @param node 变更后的完整节点行
   */
  writeNode(node: CognitionNode): void;

  /**
   * 写入一条新引用；引用只增不改。
   * @param ref 新引用
   */
  writeRef(ref: Ref): void;

  /**
   * 追加一条修订；修订只追加，不改写旧记录。
   * @param revision 新修订
   */
  appendRevision(revision: Revision): void;
}

/**
 * 单树存储端口。由模型调用，适配器绑定工作区并实现。
 * 接口单未定读写方法是否异步、快照如何释放等细节；这里统一用 Promise，实现时再定。
 */
export interface TreeStore {
  /**
   * 取某树当前已提交版本的只读快照。一次读取的多次查询都看到同一版本。
   * @param treeId 目标树
   * @returns 只读快照；读完、取消或到期后由调用方 close
   * @throws CognitionError 树不存在（missing）
   */
  openRead(treeId: TreeId): Promise<ReadSnapshot>;

  /**
   * 在同一单树事务里执行 work，成功才提交；失败回滚，数据、版本与修订都不动。
   * @param treeId 目标树
   * @param mode existing 要求树已存在；createNew 用于新建或自举，要求树尚不存在
   * @param work 在事务句柄上执行的写命令；可抛错以回滚
   * @returns work 的返回值；提交成功后才兑现
   * @throws CognitionError 树不存在或已存在、参数不合规（missing / invalid），提交失败（storage）
   */
  transact<T>(
    treeId: TreeId,
    mode: 'existing' | 'createNew',
    work: (transaction: WriteTransaction) => T | Promise<T>,
  ): Promise<T>;
}

/**
 * 一次读取所基于的已提交版本的只读快照。
 * 版本固定后数据不再变化；所有分批读按稳定键推进，分页给起点键与剩余额度，不接受裸 SQL。
 * 读节点有两条路：readNode 取含正文的完整节点，readNodeRow / listChildren 只取轻行；
 * 遍历与预算计算走后者，不因读一行标题而带出长正文。
 * 接口单未定各分批方法的分页键编码、排序细节与 close 的异步性，这里取最小形状，实现时再定。
 */
export interface ReadSnapshot {
  /** 已提交版本号；同一快照内不变，续读必须使用同一版本。 */
  readonly stamp: number;

  /**
   * 树根节点 ID。焦点可显式选根（3.2），补父链与续读也以它为顶；
   * 读取方不必先取根节点行就能知道根。
   */
  readonly rootId: NodeId;

  /**
   * 按 ID 查完整节点行，含正文。
   * @param nodeId 目标节点
   * @returns 节点；不存在时为 null
   */
  readNode(nodeId: NodeId): Promise<CognitionNode | null>;

  /**
   * 按 ID 查轻行投影，不含正文；用于遍历时先判断是否需要继续读。
   * @param nodeId 目标节点
   * @returns 轻行；不存在时为 null
   */
  readNodeRow(nodeId: NodeId): Promise<NodeRow | null>;

  /**
   * 按 ID 取修订全文；readNode 的 currentChange 指向的记录与确认目标都靠它定位。
   * @param revisionId 目标修订
   * @returns 修订；不存在时为 null
   */
  readRevision(revisionId: RevisionId): Promise<Revision | null>;

  /**
   * 按父节点分批读直接孩子的轻行，按稳定 ID 顺序推进；不读正文。
   * @param parentId 父节点 ID
   * @param after 上一批最后一行的节点 ID；null 从该父节点下第一个孩子开始
   * @param limit 本批最多返回行数；调用方可多取一条探测是否还有更多，探到的行也计费
   * @returns 本批节点轻行，可能为空
   */
  listChildren(parentId: NodeId, after: NodeId | null, limit: number): Promise<NodeRow[]>;

  /**
   * 按引用起点分批读出向引用，按引用 ID 顺序推进。
   * @param nodeId 起点节点 ID
   * @param after 上一批最后一行的引用 ID；null 从头开始
   * @param limit 本批最多返回行数
   * @returns 本批引用，可能为空
   */
  listRefsFrom(nodeId: NodeId, after: RefId | null, limit: number): Promise<Ref[]>;

  /**
   * 按树内引用目标分批读入向引用，返回原方向；外部材料引用不在其中。
   * @param nodeId 目标节点 ID
   * @param after 上一批最后一行的引用 ID；null 从头开始
   * @param limit 本批最多返回行数
   * @returns 本批引用，可能为空
   */
  listRefsTo(nodeId: NodeId, after: RefId | null, limit: number): Promise<Ref[]>;

  /**
   * 按时间键 (at, revisionId) 分批读修订，从新到旧。
   * @param nodeId 只看该节点的历史；null 表示查整棵树的时间线
   * @param after 上一批最后一行的修订 ID；null 从最新开始
   * @param limit 本批最多返回行数
   * @returns 本批修订，可能为空
   */
  listRevisions(
    nodeId: NodeId | null,
    after: RevisionId | null,
    limit: number,
  ): Promise<Revision[]>;

  /**
   * 按未确认索引分批读待确认目标；不扫描全表、不做全量计数。
   * @param by 执行者种类的非空子集：human、ai 筛形成记录，import 选导入判断
   * @param after 上一页末项对应的确认目标；null 从第一项开始
   * @param limit 本批最多返回项数
   * @returns 本批待确认目标，可能为空
   */
  listUnconfirmed(
    by: RevisionActor[],
    after: ConfirmTarget | null,
    limit: number,
  ): Promise<PendingTarget[]>;

  /**
   * 释放快照；读完、取消或到期时调用。接口单未定是否幂等，实现时再定。
   * @returns 释放完成的 Promise
   */
  close(): Promise<void>;
}

/**
 * 时钟端口。命令产生新日志时取一次；同一笔修订共享同一个时刻。
 * 接口单写的是 Instant，未定具体表示；这里用含时区偏移的 ISO 8601 字符串。
 * 导入历史不调用它补精确时间。
 */
export interface Clock {
  /**
   * 取当前时刻。
   * @returns 含时区偏移的 ISO 8601 字符串，例如 "2026-11-20T19:50:09+08:00"
   */
  now(): string;
}
