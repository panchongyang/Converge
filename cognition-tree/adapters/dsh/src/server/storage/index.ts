/**
 * DSH 的工作区 SQLite TreeStore（内核接口单 §3.3）。每棵树一个库，SQLite 承担增量事务和一致读；
 * 此入口管理连接与快照生命周期，并从已有主库生成工作区目录，不决定树规则。同步 SQLite 运行在宿主 worker。
 */
import { CognitionError } from '@cognition-tree/kernel/types';
import type { ReadSnapshot, Revision, TreeId, TreeStore, WriteTransaction } from '@cognition-tree/kernel/types';
import type { WorkspaceTreeDirectory } from '../../types/wire';
import { hasArchivedBranches, isArchived, listArchivedBranches, type ArchiveItem } from './archive';
import { Connection, storageError } from './connection';
import { claimDatabase, databaseName, discoverDatabases, locateDatabase, preserveFailedInitialization, workspacePath } from './files';
import { readMeta, readRootQuestion, type TreeMeta } from './rows';
import { SCHEMA_VERSION, type SchemaVersion } from './schema';
import { SqliteReadSnapshot } from './snapshot';
import { Transaction } from './transaction';

type Mode = 'existing' | 'createNew';
export type { ArchiveItem } from './archive';

/** 一次实际提交后的通知；修订只包含本次追加内容，顺序与追加时一致。 */
interface CommitChange { treeId: string; stamp: number; revisions: Revision[]; visibilityChanged?: true }

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
   * 枚举工作区归档的整树，或一棵活动树内所有显式归档分支的轻摘要，不改写工作区。
   * @param treeId 省略时只列整树；指定时解析该活动树，缺失或整树归档时报 missing
   */
  async listArchived(treeId?: string): Promise<ArchiveItem[]> {
    this.assertOpen();
    if (treeId !== undefined) {
      const { connection, version } = this.openActiveDatabase(treeId);
      try { return version === SCHEMA_VERSION ? listArchivedBranches(connection, treeId) : []; }
      catch (error) { throw storageError('读取归档分支失败', error); }
      finally { connection.close(); }
    }
    const items: ArchiveItem[] = [];
    try {
      for (const candidate of discoverDatabases(this.root)) {
        if (candidate.file === undefined) continue;
        try {
          const item = this.readDirectoryTree(candidate.file, candidate.treeId, true);
          if (item !== undefined) items.push({ treeId: item.treeId, title: item.rootQuestion });
        } catch { /* 无法验证的候选不作为归档返回。 */ }
      }
    } catch (error) {
      throw storageError('读取工作区归档失败', error);
    }
    return items;
  }

  /**
   * 在同一只读事务核对登记、归档状态与真实根，不读取正文或历史。
   * @param file 已通过主库及辅助文件 guard 的工作区内路径
   * @param treeId 目录项反解的域树 ID，必须与库内登记精确匹配
   * @param archived true 只查整树归档，默认只查活动树
   * @returns 对应状态的已登记根摘要；未自举或不匹配时为 undefined
   */
  private readDirectoryTree(file: string, treeId: string, archived = false): WorkspaceTreeDirectory['trees'][number] | undefined {
    const connection = new Connection(file, true);
    try {
      connection.exec('BEGIN');
      const version = connection.verifySchema();
      const meta = readMeta(connection, treeId);
      if (meta === undefined) return undefined;
      const rootId = meta.root_id;
      if ((version === SCHEMA_VERSION && isArchived(connection, rootId)) !== archived) return undefined;
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
    const { connection, meta, version } = this.openActiveDatabase(treeId);
    try {
      const filter = version === SCHEMA_VERSION && hasArchivedBranches(connection);
      const snapshot = new SqliteReadSnapshot(connection, meta, filter, () => { this.snapshots.delete(snapshot); });
      this.snapshots.add(snapshot);
      return snapshot;
    } catch (error) {
      try { connection.close(); } catch { /* 保留打开时的错误。 */ }
      throw storageError('打开工作区树数据库失败', error);
    }
  }

  /**
   * 固定已验证的活动树读版本；归档整树与缺失树同样不可打开，失败时自己关连接。
   * @param treeId 目标树 ID，须与文件中登记相符
   * @returns 由调用方负责释放的读事务，以及该事务所见的登记与格式版本
   */
  private openActiveDatabase(treeId: TreeId): { connection: Connection; meta: TreeMeta; version: SchemaVersion } {
    const name = databaseName(treeId);
    let connection: Connection | undefined;
    try {
      const location = locateDatabase(this.root, name, false);
      if (!location.present) throw new CognitionError('missing', '树不存在');
      connection = new Connection(location.file, true);
      // BEGIN 延迟读取；返回前实际读登记和归档状态，将所有查询固定在同一 WAL 帧。
      connection.exec('BEGIN');
      const version = connection.verifySchema();
      const meta = readMeta(connection, treeId);
      if (meta === undefined) throw new CognitionError('missing', '树尚未自举');
      if (version === SCHEMA_VERSION && isArchived(connection, meta.root_id)) throw new CognitionError('missing', '树不存在');
      return { connection, meta, version };
    } catch (error) {
      try { connection?.close(); } catch { /* 保留打开时的错误。 */ }
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
  async transact<T>(treeId: TreeId, mode: Mode, work: (transaction: WriteTransaction) => T | Promise<T>): Promise<T> {
    this.assertOpen();
    if (mode !== 'existing' && mode !== 'createNew') throw new CognitionError('invalid', '树存储事务模式无效');
    return this.enqueue(treeId, (name) => this.execute(name, treeId, mode, (tx) => work(tx.port())));
  }

  /** 使用同一写队列，只在事务读到的现有树版本匹配时执行 work。 */
  async transactAtStamp<T>(
    treeId: TreeId, expectedStamp: number, work: (transaction: WriteTransaction) => T | Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    if (!Number.isSafeInteger(expectedStamp) || expectedStamp < 1) {
      throw new CognitionError('invalid', 'expectedStamp 必须是正安全整数。');
    }
    return this.enqueue(treeId, (name) => this.execute(name, treeId, 'existing', (tx) => work(tx.port()), expectedStamp));
  }

  /**
   * 归档或恢复，与日常写排入同一事务队列；只有显式归档标记实际改变才更新 stamp 并通知。
   * @param treeId 目标树 ID；整树归档时只允许恢复整树
   * @param nodeId 实际节点 ID；省略或指定根均表示整树
   * @param archived 目标归档状态
   */
  async setArchived(treeId: string, nodeId: string | undefined, archived: boolean): Promise<void> {
    this.assertOpen();
    if (typeof archived !== 'boolean' || (nodeId !== undefined && (typeof nodeId !== 'string' || nodeId.trim().length === 0))) {
      throw new CognitionError('invalid', '归档目标或状态无效');
    }
    return this.enqueue(treeId, (name) => this.execute(name, treeId, 'archive', (tx, previous) => {
      if (previous === undefined) throw new CognitionError('missing', '树尚未自举');
      tx.setArchived(previous.root_id, nodeId, archived);
    }));
  }

  /**
   * Windows 大小写别名不能排进同一文件的不同写队列；树身份仍按 tree_meta 精确校验。
   * @param treeId 经过文件名转换的目标域树 ID
   * @param work 该树轮到本次写入时执行，接收经过校验的文件名
   */
  private enqueue<T>(treeId: TreeId, work: (name: string) => Promise<T>): Promise<T> {
    const name = databaseName(treeId);
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const current = previous.then(() => work(name));
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
   * @param mode 自举、日常写入或专用归档操作；只有归档操作能打开整个已归档的树
   * @param work 在事务执行期间调用，接收受控的事务与现有登记
   * @param expectedStamp 可选的已有活动树版本条件
   */
  private async execute<T>(
    name: string, treeId: TreeId, mode: Mode | 'archive',
    work: (tx: Transaction, previous: TreeMeta | undefined) => T | Promise<T>, expectedStamp?: number,
  ): Promise<T> {
    this.assertOpen();
    let connection: Connection | undefined;
    let transaction: Transaction | undefined;
    let inWork = false;
    let stamp: number;
    let value: T;
    try {
      const location = locateDatabase(this.root, name, mode === 'createNew');
      if (!location.present && mode !== 'createNew') throw new CognitionError('missing', '树不存在');
      connection = location.present ? new Connection(location.file, false) : this.initialize(location.file);
      // 切 WAL 前拒绝不受支持的结构；开始写事务后重新核对，以该事务所见版本迁移。
      connection.verifySchema();
      connection.configureWriter();
      connection.exec('BEGIN IMMEDIATE');
      const version = connection.verifySchema();
      const previous = readMeta(connection, treeId);
      if (mode !== 'createNew' && previous === undefined) throw new CognitionError('missing', '树尚未自举');
      if (mode === 'createNew' && previous !== undefined) throw new CognitionError('invalid', '树已存在，不能重复自举');
      if (mode === 'existing' && version === SCHEMA_VERSION && isArchived(connection, previous?.root_id)) {
        throw new CognitionError('missing', '树不存在');
      }
      // 在持有写锁的事务里核对实际基线；不匹配时不执行 work 或迁移。
      if (expectedStamp !== undefined && previous?.stamp !== expectedStamp) {
        throw new CognitionError('invalid', '树在读取后已有变更；请重新读取当前树并重新判断后再提交。');
      }
      // 旧库的日常操作沿用 v1；只在首次真正发生归档时随业务一起升级。
      if (mode === 'archive') connection.migrate(version);
      const filter = mode === 'existing' && version === SCHEMA_VERSION && hasArchivedBranches(connection);
      transaction = new Transaction(connection, this.onCommit !== undefined, filter);
      this.writers.set(connection, transaction);
      inWork = mode !== 'archive';
      value = await work(transaction, previous);
      inWork = false;
      transaction.finish();
      this.assertOpen();
      const rootId = transaction.prepareCommit();
      // 幂等操作连同可能的空迁移一起回滚，不改变 stamp，不发通知。
      if (mode === 'archive' && !transaction.visibilityChanged) return value;
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
    this.notify({ treeId, stamp, revisions: transaction.revisions,
      ...(transaction.visibilityChanged ? { visibilityChanged: true } : {}),
    });
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
