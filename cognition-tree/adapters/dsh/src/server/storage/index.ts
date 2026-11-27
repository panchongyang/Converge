/**
 * DSH 的工作区 SQLite TreeStore（内核接口单 §3.3）。每棵树一个库，SQLite 承担增量事务和一致读；
 * 此入口管理连接与快照生命周期，并从已有主库生成工作区目录，不决定树规则。同步 SQLite 运行在宿主 worker。
 */
import { CognitionError } from '@cognition-tree/kernel/types';
import type { ReadSnapshot, Revision, TreeId, TreeStore, WriteTransaction } from '@cognition-tree/kernel/types';
import type { WorkspaceTreeDirectory } from '../../types/wire';
import { Connection, storageError } from './connection';
import { claimDatabase, databaseName, discoverDatabases, locateDatabase, preserveFailedInitialization, workspacePath } from './files';
import { readMeta, readRootQuestion } from './rows';
import { SqliteReadSnapshot } from './snapshot';
import { Transaction } from './transaction';

type Mode = 'existing' | 'createNew';

/** 一次实际提交后的通知；修订只包含本次追加内容，顺序与追加时一致。 */
interface CommitChange { treeId: string; stamp: number; revisions: Revision[] }

/** 一个宿主工作区的存储；同实例的单树写串行，不同树独立。 */
export class SqliteTreeStore implements TreeStore {
  private readonly root: string;
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly writers = new Map<Connection, Transaction>();
  private readonly snapshots = new Set<SqliteReadSnapshot>();
  private closed = false;
  private closing: Promise<void> | undefined;

  /**
   * 绑定工作区；构造不创建目录或库。
   * @param workspaceRoot 宿主已定位的工作区根绝对路径，不能由请求替换
   * @param onCommit 可选的提交后通知；观察者失败不撤销持久化，也不使这次写入报失败
   */
  constructor(workspaceRoot: string, private readonly onCommit?: (change: CommitChange) => void) {
    this.root = workspacePath(workspaceRoot);
    if (onCommit !== undefined && typeof onCommit !== 'function') throw new TypeError('onCommit 必须是函数');
  }

  /** 关闭后不能枚举、打开快照或开始新事务。 */
  private assertOpen(): void {
    if (this.closed) throw new CognitionError('storage', '工作区树存储已关闭');
  }

  /**
   * 按稳定树 ID 自然序读取工作区已提交的根问题，不创建目录、主库或业务行。
   * @returns 每棵可读树的根摘要与无法读取的候选 ID；不含文件路径
   * @throws 工作区或存储目录不可读取时失败，不把目录异常解释成空目录
   */
  async listTrees(): Promise<WorkspaceTreeDirectory> {
    this.assertOpen();
    const directory: WorkspaceTreeDirectory = { trees: [], unavailable: [] };
    try {
      for (const { treeId, file } of discoverDatabases(this.root)) {
        if (file !== undefined) {
          try {
            const item = this.readDirectoryTree(file, treeId);
            if (item !== undefined) directory.trees.push(item);
            continue;
          } catch { /* 单库失败不妨碍其它树；不返回该库的内部异常或路径。 */ }
        }
        directory.unavailable.push(treeId);
      }
    } catch (error) {
      throw storageError('读取工作区根问题目录失败', error);
    }
    return directory;
  }

  /**
   * 在同一只读事务核对登记与真实根；用正常的 SQLite WAL 读以看到已提交帧，
   * WAL/SHM 由 SQLite 管理，不写主库业务数据，也不会读取正文或历史。
   * @param file 已通过主库及辅助文件 guard 的工作区内路径
   * @param treeId 目录项反解的域树 ID，必须与库内登记精确匹配
   * @returns 已登记根的摘要；只有格式而未提交自举时为 undefined
   */
  private readDirectoryTree(file: string, treeId: string): WorkspaceTreeDirectory['trees'][number] | undefined {
    const connection = new Connection(file, true);
    try {
      connection.exec('BEGIN');
      connection.verifySchema();
      const meta = readMeta(connection, treeId);
      if (meta === undefined) return undefined;
      const rootId = meta.root_id;
      return { treeId, rootId, rootQuestion: readRootQuestion(connection, rootId) };
    } finally {
      connection.close();
    }
  }

  /**
   * 打开已提交树的独立只读快照；读不存在的树不会建立目录、主库或业务登记。
   * @param treeId 目标树 ID
   * @returns 快照；使用完后调用快照的 close，或由存储统一处置
   */
  async openRead(treeId: TreeId): Promise<ReadSnapshot> {
    this.assertOpen();
    const name = databaseName(treeId);
    let connection: Connection | undefined;
    try {
      const location = locateDatabase(this.root, name, false);
      if (!location.present) throw new CognitionError('missing', '树不存在');
      connection = new Connection(location.file, true);
      // BEGIN 是延迟读事务；务必在交给调用方前实际读取，把 stamp 和后续所有查询固定在同一 WAL 帧。
      connection.exec('BEGIN');
      connection.verifySchema();
      const meta = readMeta(connection, treeId);
      if (meta === undefined) throw new CognitionError('missing', '树尚未自举');
      const snapshot = new SqliteReadSnapshot(connection, meta, () => { this.snapshots.delete(snapshot); });
      this.snapshots.add(snapshot);
      return snapshot;
    } catch (error) {
      try { connection?.close(); } catch { /* 保留打开时的错误，不被清理错误掩盖。 */ }
      throw storageError('打开工作区树数据库失败', error);
    }
  }

  /**
   * 依到达顺序执行同树事务，只有真实 COMMIT 成功后才返回并通知。
   * @param treeId 目标树 ID
   * @param mode existing 打开已提交树，createNew 仅当树尚未自举
   * @param work 在事务内读写明示行；其抛错会撤回本次全部写入
   * @returns work 返回值；提交失败时不返回成功
   */
  transact<T>(treeId: TreeId, mode: Mode, work: (transaction: WriteTransaction) => T | Promise<T>): Promise<T> {
    return this.enqueue(treeId, mode, work);
  }

  /** 使用同一写队列，只在事务读到的现有树版本匹配时执行 work。 */
  async transactAtStamp<T>(
    treeId: TreeId, expectedStamp: number, work: (transaction: WriteTransaction) => T | Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(expectedStamp) || expectedStamp < 1) {
      throw new CognitionError('invalid', 'expectedStamp 必须是正安全整数。');
    }
    return this.enqueue(treeId, 'existing', work, expectedStamp);
  }

  private async enqueue<T>(
    treeId: TreeId, mode: Mode, work: (transaction: WriteTransaction) => T | Promise<T>, expectedStamp?: number,
  ): Promise<T> {
    this.assertOpen();
    const name = databaseName(treeId);
    if (mode !== 'existing' && mode !== 'createNew') throw new CognitionError('invalid', '树存储事务模式无效');
    // Windows 大小写别名不能排进同一文件的不同写队列；树身份仍按 tree_meta 精确校验。
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const current = previous.then(() => this.execute(name, treeId, mode, work, expectedStamp));
    const settled = current.then(() => undefined, () => undefined);
    this.writeChains.set(key, settled);
    void settled.then(() => { if (this.writeChains.get(key) === settled) this.writeChains.delete(key); });
    return current;
  }

  /**
   * 首次把应用格式原子写入主库，不先登记业务树。
   * @param file 工作区内尚不存在的目标文件
   * @returns 已格式化的写连接
   */
  private initialize(file: string): Connection {
    const claimed = claimDatabase(file);
    let connection: Connection | undefined;
    try {
      connection = new Connection(file, false);
      connection.initialize();
      return connection;
    } catch (error) {
      try {
        connection?.close();
        preserveFailedInitialization(file, claimed);
      } catch (cleanupError) {
        throw storageError('数据库格式初始化失败，未能隔离本次预留的文件', new AggregateError([error, cleanupError]));
      }
      throw error;
    }
  }

  /**
   * 运行一笔已排队的单树事务。
   * @param name 约束后的数据库文件名
   * @param treeId 工作区中的域树 ID
   * @param mode 是否自举新树
   * @param work 调用方的事务工作
   * @param expectedStamp 可选的已有树版本条件
   */
  private async execute<T>(
    name: string, treeId: TreeId, mode: Mode, work: (tx: WriteTransaction) => T | Promise<T>, expectedStamp?: number,
  ): Promise<T> {
    this.assertOpen();
    let connection: Connection | undefined;
    let transaction: Transaction | undefined;
    let inWork = false;
    let stamp: number;
    let value: T;
    try {
      const location = locateDatabase(this.root, name, mode === 'createNew');
      if (!location.present && mode === 'existing') throw new CognitionError('missing', '树不存在');
      connection = location.present ? new Connection(location.file, false) : this.initialize(location.file);
      connection.verifySchema();
      connection.configureWriter();
      connection.exec('BEGIN IMMEDIATE');
      const previous = readMeta(connection, treeId);
      if (mode === 'existing' && previous === undefined) throw new CognitionError('missing', '树尚未自举');
      if (mode === 'createNew' && previous !== undefined) throw new CognitionError('invalid', '树已存在，不能重复自举');
      if (expectedStamp !== undefined && previous?.stamp !== expectedStamp) {
        throw new CognitionError('invalid', '树在读取后已有变更；请重新读取当前树并重新判断后再提交。');
      }
      transaction = new Transaction(connection, this.onCommit !== undefined);
      this.writers.set(connection, transaction);
      inWork = true;
      value = await work(transaction.port());
      inWork = false;
      transaction.finish();
      this.assertOpen();
      const rootId = transaction.prepareCommit();
      stamp = (previous?.stamp ?? 0) + 1;
      if (previous === undefined) {
        connection.run('INSERT INTO tree_meta (singleton, tree_id, root_id, stamp) VALUES (1, ?, ?, ?)', treeId, rootId, stamp);
      } else {
        if (previous.root_id !== rootId) throw new CognitionError('storage', '已登记的树根与文件不一致');
        connection.run('UPDATE tree_meta SET stamp = ? WHERE singleton = 1', stamp);
      }
      connection.exec('COMMIT');
    } catch (error) {
      // 保留 work 自行抛出的业务错误或原异常；适配器和 SQLite 错误映射为 storage。
      if (inWork) throw error;
      throw storageError('工作区树保存失败，本次写入未提交', error);
    } finally {
      transaction?.finish();
      if (connection !== undefined) {
        try {
          // COMMIT 失败（例如延迟外键）仍有事务；关闭前回滚。成功时只有关闭，无其他业务动作。
          connection.close();
          this.writers.delete(connection);
        } catch { /* 不覆盖原错误或把已提交写入变成失败；已跟踪的连接留给 close 再处置。 */ }
      }
    }
    this.notify({ treeId, stamp, revisions: transaction.revisions });
    return value;
  }

  /**
   * 提交结果发布到外部观察者；该类不承担观察者的重试或二次持久化。
   * @param change 已持久化的树、stamp 与本次追加修订
   */
  private notify(change: CommitChange): void {
    try { void Promise.resolve(this.onCommit?.(change)).catch(() => {}); }
    catch { /* 已成功提交，观察者故障不能改写结果。 */ }
  }

  /** 关停存储，并立即滚回仍在执行的未提交写入、释放所有快照；重复调用等待同一次关停。 */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closed = true;
      this.closing = this.dispose();
    }
    return this.closing;
  }

  /** 尝试处置每一个句柄，再统一报告关闭异常。 */
  private async dispose(): Promise<void> {
    const snapshots = [...this.snapshots].map((snapshot) => snapshot.close());
    const errors: unknown[] = [];
    for (const [connection, transaction] of this.writers) {
      transaction.finish();
      try { connection.close(); }
      catch (error) { errors.push(error); }
    }
    this.writers.clear();
    this.writeChains.clear();
    for (const result of await Promise.allSettled(snapshots)) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    if (errors.length !== 0) throw storageError('关闭工作区树存储失败', new AggregateError(errors));
  }
}
