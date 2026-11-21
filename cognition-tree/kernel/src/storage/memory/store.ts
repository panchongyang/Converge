/**
 * 内存版单树存储（接口单 3.3 的 TreeStore 端口）。
 *
 * 职责：持有每棵树的已提交状态；openRead 固定当前提交版本，transact 在同一单树事务里
 * 执行 work，成功且在 beforeCommit 完成后才发布，失败时节点、引用、修订、索引与版本都不动。
 * 同一棵树的写事务按调用顺序串行等待；不同树彼此独立。每次提交只追加本次改动的行与索引路径，
 * 不复制整棵树、全历史或全部待确认项；快照持有旧索引根，因此提交期间仍读同一版本。
 * 状态归属：本类只持有已提交状态与写队列；事务增量由 WriteTransactionImpl 持有，发布后丢弃。
 * 依赖：只依赖 ES 标准库、内核契约与本目录的表/索引实现，不接宿主 API 或 SQLite。
 * 协作：models 调 transact，queries 调 openRead；浏览器装配可传 beforeCommit 先把增量写入
 * 宿主存储，失败则本存储也回滚。
 */
import type {
  NodeId,
  ReadSnapshot,
  RevisionId,
  TreeId,
  TreeStore,
  WriteTransaction,
} from '../../types';
import { CognitionError } from '../../types';
import { cloneNode, cloneRef, cloneRevision } from './clone';
import { confirmationKey, confirmationTargetOf } from './confirmation';
import {
  addRevisionToIndexes,
  addRefToIndexes,
  updateChildren,
  type IndexRoots,
} from './indexes';
import { putNodeInIndex } from './node-table';
import type { NodeChange } from './unconfirmed';
import { MemoryReadSnapshot } from './snapshot';
import { WriteTransactionImpl } from './transaction';
import { createTreeRecord, type TreeRecord } from './tree-record';
import type { BeforeCommit, MemoryDelta, MemoryTreeStoreOptions } from './types';

/** 写事务模式：接口类型在 ports 中重复声明，这里取局部别名便于阅读。 */
type TransactMode = 'existing' | 'createNew';

/**
 * 从一个错误的 message 取可显示的补充信息；非 Error 不展开，避免把宿主对象塞进业务消息。
 * @param error beforeCommit 抛出的值
 * @returns 以冒号开头的短说明；无法提取时为空串
 */
function errorDetail(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? '：' + error.message : '';
}

/** 内存 TreeStore：每棵树一份已提交记录，单树写入串行，发布前可选执行宿主回调。 */
export class MemoryTreeStore implements TreeStore {
  private readonly trees = new Map<TreeId, TreeRecord>();
  private readonly writeChains = new Map<TreeId, Promise<void>>();
  private readonly beforeCommit: BeforeCommit | undefined;

  /**
   * 创建内存存储。
   * @param options 可选配置；beforeCommit 在每次成功提交发布前调用，可同步或异步失败
   * @throws TypeError beforeCommit 不是函数
   */
  constructor(options?: MemoryTreeStoreOptions) {
    if (options?.beforeCommit !== undefined && typeof options.beforeCommit !== 'function') {
      throw new TypeError('beforeCommit 必须是函数');
    }
    this.beforeCommit = options?.beforeCommit;
  }

  /**
   * 取某树当前已提交版本的只读快照；之后的新提交不会改变这份快照。
   * @param treeId 目标树
   * @returns 固定版本的快照
   * @throws CognitionError 树不存在（missing）
   */
  async openRead(treeId: TreeId): Promise<ReadSnapshot> {
    const tree = this.trees.get(treeId);
    if (tree === undefined || tree.rootId === null) {
      throw new CognitionError('missing', `树 ${treeId} 不存在`);
    }
    return new MemoryReadSnapshot({
      version: tree.stamp,
      rootId: tree.rootId,
      nodes: tree.nodes,
      revisions: tree.revisions,
      indexes: tree.indexes,
      unconfirmed: tree.unconfirmed.roots,
    });
  }

  /**
   * 在单树事务里执行 work，成功才提交；同一棵树的调用按到达顺序串行。
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
  ): Promise<T> {
    const previous = this.writeChains.get(treeId) ?? Promise.resolve();
    const current = previous.then(
      () => this.execute(treeId, mode, work),
      () => this.execute(treeId, mode, work),
    );
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(treeId, settled);
    void settled.then(() => {
      if (this.writeChains.get(treeId) === settled) this.writeChains.delete(treeId);
    });
    return current;
  }

  /**
   * 在串行队列的一段里执行一个事务；work 结束即让句柄失效，再走提交。
   * @param treeId 目标树
   * @param mode 事务模式
   * @param work 调用方的写命令
   * @returns work 的返回值
   */
  private async execute<T>(
    treeId: TreeId,
    mode: TransactMode,
    work: (transaction: WriteTransaction) => T | Promise<T>,
  ): Promise<T> {
    if (mode !== 'existing' && mode !== 'createNew') {
      throw new CognitionError('invalid', `不认识的存储模式 ${String(mode)}`);
    }
    const existing = this.trees.get(treeId);
    if (mode === 'existing' && existing === undefined) {
      throw new CognitionError('missing', `树 ${treeId} 不存在`);
    }
    if (mode === 'createNew' && existing !== undefined) {
      throw new CognitionError('invalid', `树 ${treeId} 已存在，不能重复创建`);
    }

    const base = existing ?? createTreeRecord();
    const transaction = new WriteTransactionImpl(base);
    // work 只拿到端口方法的闭包；表/索引/提交用的内部读写不随句柄逃逸。
    const port: WriteTransaction = {
      readNode: (nodeId) => transaction.readNode(nodeId),
      readRevision: (revisionId) => transaction.readRevision(revisionId),
      hasConfirmation: (target) => transaction.hasConfirmation(target),
      writeNode: (node) => transaction.writeNode(node),
      writeRef: (ref) => transaction.writeRef(ref),
      appendRevision: (revision) => transaction.appendRevision(revision),
    };
    let value: T;
    try {
      value = await work(port);
    } finally {
      transaction.markFinished();
    }
    return this.commit(treeId, mode, base, transaction, value);
  }

  /**
   * 校验根与索引前提，计算本次提交的索引路径与增量，执行发布前回调，然后同步发布。
   * 发布前的任何失败都只丢弃事务增量，已提交状态与版本保持不变。
   * @param treeId 目标树
   * @param mode 事务模式
   * @param base 事务起点的树记录；createNew 时是尚未登记的空记录
   * @param transaction 已结束的写事务，提供本次增量
   * @param value work 的返回值
   * @returns work 的返回值
   * @throws CognitionError 根不合规或 currentChange 指向无效修订（invalid），beforeCommit 失败（storage）
   */
  private async commit<T>(
    treeId: TreeId,
    mode: TransactMode,
    base: TreeRecord,
    transaction: WriteTransactionImpl,
    value: T,
  ): Promise<T> {
    const changes = transaction.changes();
    const rootId = this.resolveRoot(mode, base, changes);

    let indexes: IndexRoots = base.indexes;
    let nodes = base.nodes;
    for (const change of changes) {
      indexes = updateChildren(indexes, change.before, change.after);
      nodes = putNodeInIndex(nodes, change.after);
    }
    for (const ref of transaction.refs()) {
      indexes = addRefToIndexes(indexes, ref);
    }
    for (const revision of transaction.revisions()) {
      indexes = addRevisionToIndexes(indexes, revision);
    }

    const prepared = base.unconfirmed.prepare(
      changes,
      (revisionId: RevisionId) => transaction.getRevision(revisionId),
      (nodeId: NodeId) => transaction.getNode(nodeId),
    );

    if (this.beforeCommit !== undefined) {
      // 只有宿主需要落盘时才构造独立增量；回调修改它不影响内存提交。
      const delta: MemoryDelta = {
        nodes: transaction.nodesAfter().map(cloneNode),
        refs: transaction.refs().map(cloneRef),
        revisions: transaction.revisions().map(cloneRevision),
      };
      try {
        await this.beforeCommit(treeId, mode, delta);
      } catch (error) {
        throw new CognitionError(
          'storage',
          `树 ${treeId} 保存失败，本次修改已回滚${errorDetail(error)}`,
        );
      }
    }

    // 以下为同步发布段：beforeCommit 已成功，状态一次性推进，不再有可失败的异步步骤。
    const stamp = base.stamp + 1;
    base.nodes = nodes;
    for (const ref of transaction.refs()) {
      base.refs.append(ref);
    }
    for (const revision of transaction.revisions()) {
      base.revisions.append(revision, stamp);
      const target = confirmationTargetOf(revision);
      if (target !== null) base.confirmedTargets.add(confirmationKey(target));
    }
    base.indexes = indexes;
    base.unconfirmed.apply(prepared);
    base.rootId = rootId;
    base.stamp = stamp;
    if (mode === 'createNew') this.trees.set(treeId, base);
    return value;
  }

  /**
   * 决定提交后的根：createNew 必须恰好写入一个无父节点的新根；
   * existing 只允许根保持无父、其他节点保持有父，避免存储层出现第二个根。
   * @param mode 事务模式
   * @param base 事务起点的树记录
   * @param changes 本次节点写入的前后行
   * @returns 提交后的根节点 ID
   * @throws CognitionError 根缺失、不唯一或父子关系不合规（invalid）
   */
  private resolveRoot(
    mode: TransactMode,
    base: TreeRecord,
    changes: readonly NodeChange[],
  ): NodeId {
    if (mode === 'createNew') {
      const roots = changes.filter((change) => change.after.parentId === null);
      if (roots.length !== 1) {
        throw new CognitionError('invalid', '创建树的事务必须写入恰好一个根节点，已回滚');
      }
      return (roots[0] as NodeChange).id;
    }

    const rootId = base.rootId;
    if (rootId === null) {
      throw new CognitionError('invalid', '已提交的树缺少根节点，已回滚');
    }
    for (const change of changes) {
      if (change.after.id === rootId) {
        if (change.after.parentId !== null) {
          throw new CognitionError('invalid', '根节点不能改为有父节点，已回滚');
        }
      } else if (change.after.parentId === null) {
        throw new CognitionError('invalid', `节点 ${change.after.id} 不能成为第二个根，已回滚`);
      }
    }
    return rootId;
  }
}
