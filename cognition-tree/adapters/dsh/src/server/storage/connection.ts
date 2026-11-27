/** 工作线程里的一个 node:sqlite 连接。缓存本连接实际用到的固定语句，不持有树行或跨树句柄。 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { CognitionError } from '@cognition-tree/kernel/types';
import { APPLICATION_ID, ARCHIVE_SCHEMA, LEGACY_SCHEMA, LEGACY_SCHEMA_VERSION, SCHEMA, SCHEMA_VERSION, type SchemaVersion } from './schema';

/**
 * 把宿主或 SQLite 异常转为可展示的存储错误，同时保留仅供上层诊断的原始原因。
 * @param message 不含文件系统路径的中文说明
 * @param cause 原始异常；内核错误保持不变
 * @returns 存储错误或原有内核错误
 */
export function storageError(message: string, cause: unknown): CognitionError {
  if (cause instanceof CognitionError) return cause;
  const error = new CognitionError('storage', message);
  Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

/** 一个专属读快照或一次写事务的连接，关闭必释放语句与事务。 */
export class Connection {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  /**
   * 打开已在文件边界检查过的数据库。扩展禁用；不会阻塞等待外部写锁。
   * @param file 已验证的工作区内主库路径
   * @param readOnly 是否用于只读快照
   */
  constructor(file: string, readOnly: boolean) {
    this.db = new DatabaseSync(file, {
      readOnly, timeout: 0, allowExtension: false,
      enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false,
    });
    try {
      this.db.exec('PRAGMA trusted_schema = OFF');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /**
   * 取得或预备一条当前连接的固定语句，不缓存 SQL 参数和结果。
   * @param sql 适配器定义的语句，不取自外部输入
   */
  private prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (stmt === undefined) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * 执行一段固定控制或建表语句，不接受外部输入。
   * @param sql 适配器内部事务控制或 DDL
   */
  exec(sql: string): void { this.db.exec(sql); }

  /**
   * 执行索引点查或 LIMIT 1，取首行。
   * @param sql 固定 SQL
   * @param params 原样按占位符绑定的值
   */
  get<Row>(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.prepare(sql).get(...params) as Row | undefined;
  }

  /**
   * 取一组查询结果；调用点只用于有 LIMIT 的索引页、单目标反查或固定大小的模式检查。
   * @param sql 固定 SQL
   * @param params 原样按占位符绑定的值
   */
  all<Row>(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.prepare(sql).all(...params) as Row[];
  }

  /**
   * 执行一条变更语句。
   * @param sql 固定 SQL
   * @param params 原样按占位符绑定的值
   */
  run(sql: string, ...params: SQLInputValue[]): void { this.prepare(sql).run(...params); }

  /**
   * 初始化新文件的格式，不创建业务树。用回滚日志使归属标记与 schema 原子落入主库头，
   * 此后才切 WAL。业务自举失败时，由于 tree_meta 无行，可关闭、重开、再次自举。
   */
  initialize(): void {
    this.exec('BEGIN IMMEDIATE');
    this.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`);
    this.exec(SCHEMA.join(';\n'));
    this.exec('COMMIT');
  }

  /** 检查当前 SQLite 事务（含 WAL）中的版本和对应的精确结构，不触及业务行。 */
  verifySchema(): SchemaVersion {
    const version = this.get<{ user_version: number }>('PRAGMA user_version')?.user_version;
    if ((version !== LEGACY_SCHEMA_VERSION && version !== SCHEMA_VERSION)
      || this.get<{ application_id: number }>('PRAGMA application_id')?.application_id !== APPLICATION_ID) {
      throw new CognitionError('storage', '工作区数据库格式不受支持');
    }
    // 排除 SQLite 管理的统计表及自动索引；未知或被重写的结构都不接受。
    const expected = new Set(version === LEGACY_SCHEMA_VERSION ? LEGACY_SCHEMA : SCHEMA);
    const entries = this.all<{ sql: string }>(
      "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' LIMIT ?", expected.size + 1,
    );
    if (entries.length !== expected.size || entries.some(({ sql }) => !expected.delete(sql))) {
      throw new CognitionError('storage', '工作区数据库结构不受支持');
    }
    return version;
  }

  /**
   * 在调用方的写事务内增量升级；业务失败时 DDL 与版本头一同回滚。
   * @param version 已在该事务中精确核对的版本
   */
  migrate(version: SchemaVersion): void {
    if (version !== LEGACY_SCHEMA_VERSION) return;
    this.exec(ARCHIVE_SCHEMA.join(';\n'));
    this.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** 写连接启用 WAL，确认实际模式；完整同步保证 COMMIT 成功后才可通知。 */
  configureWriter(): void {
    if (this.get<{ journal_mode: string }>('PRAGMA journal_mode = WAL')?.journal_mode !== 'wal') {
      throw new CognitionError('storage', '工作区数据库无法启用 WAL');
    }
    this.exec('PRAGMA synchronous = FULL');
  }

  /** 幂等回滚未结束的读/写事务并释放连接；即使回滚出错也尝试关句柄。 */
  close(): void {
    if (!this.db.isOpen) return;
    try {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
    } finally {
      this.statements.clear();
      this.db.close();
    }
  }
}
