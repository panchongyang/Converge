/** 专属只读连接上的 WAL 快照。每次 seek 都在读过 stamp 的同一 SQLite 事务内。 */
import { CognitionError } from '@cognition-tree/kernel/types';
import type {
  CognitionNode, ConfirmTarget, DailyActor, NodeId, NodeRow, PendingTarget, ReadSnapshot, Ref, RefId,
  Revision, RevisionActor, RevisionId,
} from '@cognition-tree/kernel/types';
import { type Connection, storageError } from './connection';
import { idKey } from './order-keys';
import {
  confirmationKey, nodeRow, readNode, readNodeRow, readRevision, refRow, revisionRow,
  type RevisionKey, type SqlRef, type SqlRevision, type TreeMeta,
} from './rows';
import { SQL, VISIBLE_SQL, type ReadSql } from './schema';

interface PendingFormationRow {
  revision_id: RevisionId;
  by: DailyActor;
  time_key: Uint8Array;
  id_key: Uint8Array;
  at: string;
  summary: string;
}

/**
 * 同内存端口一样，将非法页大小处理为不取，落在 SQLite 能表示的整数范围内。
 * @param limit 请求规定的最大行数
 */
function pageSize(limit: number): number {
  return Number.isFinite(limit) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(limit))) : 0;
}

/**
 * 取得续读锚点在该快照中的键，不取正文。
 * @param db 固定版本的只读连接
 * @param sql 按该快照可见性选择的游标点查语句
 * @param id 上一页最后一条修订 ID
 */
function cursorKey(db: Connection, sql: string, id: RevisionId): RevisionKey {
  const cursor = db.get<RevisionKey>(sql, id);
  if (cursor === undefined) throw new CognitionError('invalid', '分页续读的修订在该快照中不存在');
  return cursor;
}

/**
 * 合并人/AI 两个降序索引流时挑选更新的一条。
 * @param left 左流当前位置
 * @param right 右流当前位置
 * @returns 左侧形成记录较新时为 true
 */
function newer(left: PendingFormationRow, right: PendingFormationRow): boolean {
  return (Buffer.compare(left.time_key, right.time_key) || Buffer.compare(left.id_key, right.id_key)) > 0;
}

/** 持有打开时的版本、根节点和专属连接；不共享写连接，不在内存复制树。 */
export class SqliteReadSnapshot implements ReadSnapshot {
  readonly stamp: number;
  readonly rootId: NodeId;
  private readonly sql: ReadSql;
  private connection: Connection | undefined;
  private release: (() => void) | undefined;

  /**
   * 包装已用树登记固定读版本的连接。
   * @param connection 已 BEGIN 且已读取登记的只读连接
   * @param meta 该读版本的树根与 stamp
   * @param filter 当前版本有隐藏分支时启用归档可见性过滤
   * @param release 关闭后从 TreeStore 的跟踪集合移除
   */
  constructor(connection: Connection, meta: TreeMeta, filter: boolean, release: () => void) {
    this.connection = connection;
    this.sql = filter ? VISIBLE_SQL : SQL;
    this.release = release;
    this.stamp = meta.stamp;
    this.rootId = meta.root_id;
  }

  /**
   * 在同一快照上完成一次 SQLite 查询并翻译失败，不在关闭后重开连接。
   * @param query 针对当前快照连接的同步索引查询
   */
  private read<T>(query: (db: Connection) => T): T {
    if (this.connection === undefined) throw new CognitionError('storage', '树的读快照已关闭');
    try { return query(this.connection); }
    catch (error) { throw storageError('读取工作区数据库失败', error); }
  }

  /**
   * 查完整节点。
   * @param nodeId 目标节点；此版本未出现时返回 null
   */
  async readNode(nodeId: NodeId): Promise<CognitionNode | null> {
    return this.read((db) => readNode(db, nodeId, this.sql.node));
  }

  /** 点查详情确认控件所需的布尔值，不查或返回隐藏记录。@param nodeId 已读的可见节点，投影中没有形成指针。 */
  async hasUnprojectedCurrentChange(nodeId: NodeId): Promise<boolean> {
    return this.read((db) => this.sql === VISIBLE_SQL
      && db.get('SELECT 1 FROM nodes WHERE id = ? AND change_id IS NOT NULL', nodeId) !== undefined);
  }

  /**
   * 查不含正文的节点轻行。
   * @param nodeId 目标节点；此版本未出现时返回 null
   */
  async readNodeRow(nodeId: NodeId): Promise<NodeRow | null> {
    return this.read((db) => readNodeRow(db, nodeId, this.sql.nodeRow));
  }

  /**
   * 查单笔修订全文。
   * @param revisionId 目标修订；此版本未出现时返回 null
   */
  async readRevision(revisionId: RevisionId): Promise<Revision | null> {
    return this.read((db) => readRevision(db, revisionId, this.sql.revision));
  }

  /**
   * 按父节点和自然 ID seek 直接孩子；只查询轻行。
   * @param parentId 真实父节点
   * @param after 上一批末项 ID；null 从头开始
   * @param limit 本批额度
   */
  async listChildren(parentId: NodeId, after: NodeId | null, limit: number): Promise<NodeRow[]> {
    return this.read((db) => {
      const take = pageSize(limit);
      if (take === 0) return [];
      type Row = Parameters<typeof nodeRow>[0];
      return (after === null ? db.all<Row>(this.sql.children[0], parentId, take)
        : db.all<Row>(this.sql.children[1], parentId, idKey(after), take)).map(nodeRow);
    });
  }

  /**
   * 读取出向引用，包含指向材料的边。
   * @param nodeId 引用起点
   * @param after 上一批末项引用 ID；null 从头开始
   * @param limit 本批额度
   */
  async listRefsFrom(nodeId: NodeId, after: RefId | null, limit: number): Promise<Ref[]> {
    return this.listRefs(this.sql.refsFrom, nodeId, after, limit);
  }

  /**
   * 读取树内入向引用，保留各边的原始方向。
   * @param nodeId 树内引用目标
   * @param after 上一批末项引用 ID；null 从头开始
   * @param limit 本批额度
   */
  async listRefsTo(nodeId: NodeId, after: RefId | null, limit: number): Promise<Ref[]> {
    return this.listRefs(this.sql.refsTo, nodeId, after, limit);
  }

  /**
   * 依据一侧端点索引和自然 ID seek 引用。
   * @param sql 此侧端点的首页及续页语句
   * @param nodeId 匹配端点的节点 ID
   * @param after 上一批末项引用 ID；null 从头开始
   * @param limit 本批额度
   */
  private listRefs(sql: readonly [string, string], nodeId: NodeId, after: RefId | null, limit: number): Ref[] {
    return this.read((db) => {
      const take = pageSize(limit);
      if (take === 0) return [];
      return (after === null ? db.all<SqlRef>(sql[0], nodeId, take)
        : db.all<SqlRef>(sql[1], nodeId, idKey(after), take)).map(refRow);
    });
  }

  /**
   * 按真实发生时间、自然修订 ID 从新到旧读取。
   * @param nodeId 节点历史；null 代表树时间线
   * @param after 该快照内的上一批末项修订 ID；null 从最新开始
   * @param limit 本批额度
   */
  async listRevisions(nodeId: NodeId | null, after: RevisionId | null, limit: number): Promise<Revision[]> {
    return this.read((db) => {
      const take = pageSize(limit);
      if (take === 0) return [];
      const cursor = after === null ? undefined : cursorKey(db, this.sql.revisionKey, after);
      if (nodeId === null) return (cursor === undefined ? db.all<SqlRevision>(this.sql.revisions[0], take)
        : db.all<SqlRevision>(this.sql.revisions[1], cursor.time_key, cursor.id_key, take)).map(revisionRow);
      return (cursor === undefined ? db.all<SqlRevision>(this.sql.nodeHistory[0], nodeId, take)
        : db.all<SqlRevision>(this.sql.nodeHistory[1], nodeId, cursor.time_key, cursor.id_key, take)).map(revisionRow);
    });
  }

  /**
   * 使用按执行者分组的稀疏索引读形成，再读导入判断；只对实际返回的形成反查其现有成员。
   * @param by human、ai（形成）和 import（导入判断）的子集
   * @param after 上一批末项目标；null 从第一项开始
   * @param limit 本批最多返回的待确认目标数
   */
  async listUnconfirmed(by: RevisionActor[], after: ConfirmTarget | null, limit: number): Promise<PendingTarget[]> {
    return this.read((db) => {
      const take = pageSize(limit);
      if (take === 0) return [];
      const result: PendingTarget[] = [];
      const [kind, afterId] = after === null ? [null, null] : confirmationKey(after);
      if (kind !== 'seed') {
        const cursor = afterId === null ? undefined : cursorKey(db, this.sql.revisionKey, afterId);
        if (cursor !== undefined && (cursor.kind !== 'formation' || cursor.by === 'import')) {
          throw new CognitionError('invalid', '续读键不是日常形成记录');
        }
        const humans = by.includes('human') ? this.formationPage(db, 'human', cursor, take) : [];
        const agents = by.includes('ai') ? this.formationPage(db, 'ai', cursor, take) : [];
        let human = 0;
        let ai = 0;
        // 每个索引至多取一页。两流线性合并，不把整表拉到 JS，也不扫描其他执行者。
        while (result.length < take && (human < humans.length || ai < agents.length)) {
          const item = ai >= agents.length || (human < humans.length && newer(humans[human], agents[ai]))
            ? humans[human++] : agents[ai++];
          const nodeIds = db.all<{ id: string }>(this.sql.pendingMembers, item.revision_id).map(({ id }) => id);
          result.push({ revisionId: item.revision_id, by: item.by, at: item.at, summary: item.summary, nodeIds });
        }
      }
      if (result.length < take && by.includes('import')) {
        const remaining = take - result.length;
        type Seed = { id: string; title: string };
        const seeds = kind === 'seed' && afterId !== null ? db.all<Seed>(this.sql.pendingImports[1], idKey(afterId), remaining)
          : db.all<Seed>(this.sql.pendingImports[0], remaining);
        for (const { id, title } of seeds) result.push({ seedNodeId: id, title });
      }
      return result;
    });
  }

  /**
   * 对指定执行者做一次有界、降序的形成 seek。
   * @param db 固定版本的只读连接
   * @param by 单一日常执行者种类
   * @param cursor 上一项形成键；undefined 从最新开始
   * @param take 已校验页额度
   */
  private formationPage(db: Connection, by: DailyActor, cursor: RevisionKey | undefined, take: number): PendingFormationRow[] {
    return cursor === undefined ? db.all<PendingFormationRow>(this.sql.pendingFormations[0], by, take)
      : db.all<PendingFormationRow>(this.sql.pendingFormations[1], by, cursor.time_key, cursor.id_key, take);
  }

  /** 幂等释放读事务和连接；之后本快照不再提供查询。 */
  async close(): Promise<void> {
    if (this.connection === undefined) return;
    try { this.connection.close(); }
    catch (error) { throw storageError('关闭树的读快照失败', error); }
    finally {
      this.connection = undefined;
      const release = this.release;
      this.release = undefined;
      release?.();
    }
  }
}
