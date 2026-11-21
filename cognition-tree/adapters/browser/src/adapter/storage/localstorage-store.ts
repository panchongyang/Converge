/**
 * 浏览器测试存储 · TreeStore 适配器
 *
 * 职责：把内核的 MemoryTreeStore 接到 localStorage 上，实现正式 TreeStore 端口：
 * - 读：首次访问某棵树时，从 TreeJournal 按序重放增量，把已提交历史装回内存；
 * - 写：单树事务先经 MemoryTreeStore 校验并生成增量，提交前写日志；写失败则事务回滚；
 * - 开发坞控制：模拟下一次保存失败、读取真实占用字节、清空本树的测试数据。
 *
 * 状态归属：内存中的树事实由 MemoryTreeStore 持有；持久化字节由 TreeJournal 持有；
 * 本类只持有已重放/加载中的树集合与“待通知的提交”队列。
 * 边界：不解释命令规则，不复制索引或事务语义；损坏与写失败都翻译成 storage 错误。
 * 协作：env 在写操作 dispatch 成功后用 takeCommit 发出 UI 通知；开发坞调用控制方法。
 *
 * 依据：docs/design/kernel-interfaces.md §3.3；localStorage 只用于浏览器测试，不是正式存储。
 */
import {
  CognitionError,
  type ReadSnapshot,
  type Revision,
  type TreeId,
  type TreeStore,
  type WriteTransaction,
} from '@cognition-tree/kernel/types';
import { MemoryTreeStore, type MemoryDelta } from '@cognition-tree/kernel/storage/memory';
import { TreeJournal, type JournalMode } from './journal';

/** 一次已提交事务的通知内容；只含提交后版本与本次新增的修订。 */
export interface CommittedChange {
  treeId: TreeId;
  /** 提交后的新版本；与重放后的快照版本一致。 */
  stamp: number;
  /** 本次提交新增的修订，从旧到新。 */
  revisions: Revision[];
}

export interface LocalStorageTreeStoreOptions {
  /** 浏览器存储对象，或测试里的内存替身。 */
  storage: Storage;
  /** 键前缀；缺省是与原型 v1 隔离的测试命名空间。 */
  prefix?: string;
}

/**
 * localStorage 版 TreeStore。
 * 一个实例对应一个页面会话；同一棵树只从日志重放一次，此后读内存快照。
 */
export class LocalStorageTreeStore implements TreeStore {
  private readonly journal: TreeJournal;
  private readonly inner: MemoryTreeStore;
  /** 已完成重放的树；此后 inner 持有完整已提交状态。 */
  private readonly loaded = new Set<TreeId>();
  /** 正在重放的树：并发首次访问共享同一个 Promise，避免重复 createNew。 */
  private readonly loading = new Map<TreeId, Promise<void>>();
  /** 重放失败（数据损坏或语义不成立）的树；后续访问继续报同一个 storage 错误。 */
  private readonly failed = new Map<TreeId, CognitionError>();
  /** 正在重放的树；beforeCommit 据此跳过把重放当成新提交。 */
  private readonly hydrating = new Set<TreeId>();
  /** 已提交但尚未通知的变更队列；按提交顺序取出。 */
  private readonly commits: CommittedChange[] = [];
  /** 每棵树在本页内存里已重放/提交到的版本；写入前核对 head，避免把两个版本拼在一起。 */
  private readonly baseCommits = new Map<TreeId, number>();
  /** 开发坞的“让下一次保存失败”是否已就绪。 */
  private armed = false;

  constructor(options: LocalStorageTreeStoreOptions) {
    this.journal = new TreeJournal(options.storage, options.prefix);
    this.inner = new MemoryTreeStore({
      beforeCommit: (treeId, mode, delta) => this.beforeCommit(treeId, mode, delta),
    });
  }

  /**
   * 取某树当前已提交版本的只读快照；第一次访问先重放持久化历史。
   * @param treeId 目标树
   * @returns 只读快照
   * @throws CognitionError storage：历史损坏；missing：树不存在
   */
  async openRead(treeId: TreeId): Promise<ReadSnapshot> {
    await this.ensureLoaded(treeId);
    return this.inner.openRead(treeId);
  }

  /**
   * 在单树事务里执行 work；提交前持久化增量，失败回滚且不影响已保存历史。
   * @param treeId 目标树
   * @param mode existing 要求树已存在；createNew 仅自举使用，要求尚不存在
   * @param work 在事务句柄上执行的写命令
   * @returns work 的返回值；提交成功后才兑现
   * @throws CognitionError storage：无法写入；其余见 MemoryTreeStore
   */
  async transact<T>(
    treeId: TreeId,
    mode: 'existing' | 'createNew',
    work: (transaction: WriteTransaction) => T | Promise<T>,
  ): Promise<T> {
    await this.ensureLoaded(treeId);
    return this.inner.transact(treeId, mode, work);
  }

  /**
   * 准备让下一次写事务在持久化时失败；用于开发坞验证“没有记下、树不变”。
   * 失败只消耗这一次机会；校验失败或越权不会用掉它。
   */
  armNextCommitFailure(): void {
    this.armed = true;
  }

  /** “让下一次保存失败”是否仍待触发。 */
  failureArmed(): boolean {
    return this.armed;
  }

  /**
   * 取走一棵树最早一条待通知的提交；没有返回 undefined。
   * 调用点在 dispatch 成功之后，因此只有真正提交成功的事务才会被通知。
   * @param treeId 目标树
   */
  takeCommit(treeId: TreeId): CommittedChange | undefined {
    const index = this.commits.findIndex((c) => c.treeId === treeId);
    if (index < 0) return undefined;
    return this.commits.splice(index, 1)[0];
  }

  /**
   * 丢弃尚未通知的提交（dispatch 在持久化后仍失败等异常路径）。
   * @param treeId 目标树
   */
  discardCommit(treeId: TreeId): void {
    const index = this.commits.findIndex((c) => c.treeId === treeId);
    if (index >= 0) this.commits.splice(index, 1);
  }

  /**
   * 已提交版本；树不存在时为 null。损坏的历史也返回 null，读取时会给出具体原因。
   * @param treeId 目标树
   */
  committedStamp(treeId: TreeId): number | null {
    if (this.failed.has(treeId)) return null;
    try {
      return this.journal.head(treeId)?.commits ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 这棵树在测试存储里的实际 UTF-8 字节数。
   * @param treeId 目标树
   */
  storageBytes(treeId: TreeId): number {
    return this.journal.bytes(treeId);
  }

  /**
   * 清空这棵树在测试命名空间里的数据；调用方随后应重载页面，避免内存里还留着旧状态。
   * @param treeId 目标树
   */
  clear(treeId: TreeId): void {
    this.journal.clear(treeId);
    this.loaded.delete(treeId);
    this.failed.delete(treeId);
    this.loading.delete(treeId);
    this.baseCommits.delete(treeId);
  }

  /**
   * 从日志重放某棵树；不存在就什么都不做，交给内核在 createNew 时判定。
   * @param treeId 目标树
   */
  private async ensureLoaded(treeId: TreeId): Promise<void> {
    const failure = this.failed.get(treeId);
    if (failure) throw failure;
    if (this.loaded.has(treeId)) return;
    const pending = this.loading.get(treeId);
    if (pending) return pending;
    const task = this.hydrate(treeId)
      .then(() => {
        this.loaded.add(treeId);
      })
      .catch((e: unknown) => {
        const error =
          e instanceof CognitionError
            ? e
            : new CognitionError('storage', `测试存储里的 ${treeId} 无法重放：${e instanceof Error ? e.message : String(e)}`);
        this.failed.set(treeId, error);
        throw error;
      })
      .finally(() => {
        this.loading.delete(treeId);
      });
    this.loading.set(treeId, task);
    return task;
  }

  /**
   * 按序重放 head 指向的全部增量。重放用事务逐步还原当前节点行、引用与修订；
   * 重放期间 beforeCommit 跳过持久化，避免把历史再写一遍。
   * @param treeId 目标树
   */
  private async hydrate(treeId: TreeId): Promise<void> {
    const head = this.journal.head(treeId);
    if (head === null) return;
    this.hydrating.add(treeId);
    try {
      for (let seq = 1; seq <= head.commits; seq += 1) {
        const delta = this.journal.delta(treeId, seq);
        await this.inner.transact(treeId, delta.mode, (tx) => {
          this.applyDelta(tx, delta);
        });
      }
      this.baseCommits.set(treeId, head.commits);
    } catch (e) {
      if (e instanceof CognitionError && e.code === 'storage') throw e;
      throw new CognitionError(
        'storage',
        `测试存储里的 ${treeId} 无法重放：${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.hydrating.delete(treeId);
    }
  }

  /**
   * 把一条增量写进重放事务：节点按 ID 覆盖为已提交行，引用与修订只追加。
   * @param tx 重放事务
   * @param delta 已读出的增量
   */
  private applyDelta(tx: WriteTransaction, delta: MemoryDelta): void {
    for (const node of delta.nodes) tx.writeNode(node);
    for (const ref of delta.refs) tx.writeRef(ref);
    for (const revision of delta.revisions) tx.appendRevision(revision);
  }

  /**
   * MemoryTreeStore 的提交前钩子：先写日志，再让内存发布。
   * 抛错会阻止提交并回滚；重放阶段直接返回，不重复保存历史。
   * @param treeId 目标树
   * @param mode 事务模式
   * @param delta 本次提交的增量
   */
  private beforeCommit(treeId: TreeId, mode: JournalMode, delta: MemoryDelta): void {
    if (this.hydrating.has(treeId)) return;
    if (this.armed) {
      this.armed = false;
      throw new CognitionError('storage', '模拟保存失败：测试存储没有写入，这次变更已回滚');
    }
    // 与内存里的版本对齐：页面外若有别的标签页写入，宁可失败也不把两段历史接在一起。
    const previous = this.baseCommits.get(treeId) ?? 0;
    const stamp = this.journal.append(
      treeId,
      mode,
      { nodes: delta.nodes, refs: delta.refs, revisions: delta.revisions },
      previous,
    );
    this.baseCommits.set(treeId, stamp);
    // 通知延后到 dispatch 成功之后由 takeCommit 取走，避免内存发布失败却先发了通知。
    this.commits.push({ treeId, stamp, revisions: [...delta.revisions] });
  }
}
