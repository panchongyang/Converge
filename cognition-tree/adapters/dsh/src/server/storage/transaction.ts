/** 单树事务的写端。明示行直接进入 SQLite 未提交事务；这里只持有待重算索引的键与通知增量。 */
import { CognitionError } from '@cognition-tree/kernel/types';
import type { CognitionNode, ConfirmTarget, NodeId, Ref, Revision, RevisionId, WriteTransaction } from '@cognition-tree/kernel/types';
import { type Connection, storageError } from './connection';
import { idKey, timeKey } from './order-keys';
import { confirmationKey, readNode, readRevision } from './rows';
import { SQL } from './schema';

interface NodeBefore {
  parent_id: NodeId | null;
  change_id: RevisionId | null;
  confirmation: string | null;
}

const ROOT = 'SELECT id FROM nodes WHERE parent_id IS NULL LIMIT 1';
const NODE_BEFORE = 'SELECT parent_id, change_id, confirmation FROM nodes WHERE id = ?';

/** 一次 work 的句柄与提交准备，不重放修订、不复制节点表。 */
export class Transaction {
  private readonly touched = new Set<RevisionId>();
  private active = true;
  private failure: CognitionError | undefined;

  /** 仅本次追加的修订副本；未装配通知时不复制。 */
  readonly revisions: Revision[] = [];

  /**
   * 绑定已开始的 SQLite 事务。
   * @param connection 该树唯一当前写连接
   * @param collectRevisions 是否需要为提交后的通知收集增量
   */
  constructor(private readonly connection: Connection, private readonly collectRevisions: boolean) {}

  /** 仅暴露 TreeStore 写端口方法；连接和提交准备不交给 work。 */
  port(): WriteTransaction {
    return {
      readNode: this.readNode.bind(this),
      readRevision: this.readRevision.bind(this),
      hasConfirmation: this.hasConfirmation.bind(this),
      writeNode: this.writeNode.bind(this),
      writeRef: this.writeRef.bind(this),
      appendRevision: this.appendRevision.bind(this),
    };
  }

  /**
   * 执行端口操作；任何行级失败都使事务不能提交，即使 work 捕获了该错误。
   * @param operation 一次同步的读或写
   * @returns 行或写入结果
   */
  private perform<T>(operation: () => T): T {
    if (!this.active) throw new CognitionError('storage', '写事务已结束');
    if (this.failure !== undefined) throw this.failure;
    try { return operation(); }
    catch (error) {
      this.failure = storageError('工作区数据库的事务操作失败，本次写入未提交', error);
      throw this.failure;
    }
  }

  /**
   * 事务内按 ID 读取含正文节点，可见本次已写行。
   * @param id 目标节点 ID
   */
  private async readNode(id: NodeId): Promise<CognitionNode | null> {
    return this.perform(() => readNode(this.connection, id));
  }

  /**
   * 事务内按 ID 读修订，可见本次已追加记录。
   * @param id 目标修订 ID
   */
  private async readRevision(id: RevisionId): Promise<Revision | null> {
    return this.perform(() => readRevision(this.connection, id));
  }

  /**
   * 点查确认目标的稀疏索引，不读取历史正文。
   * @param target 形成记录或导入判断
   */
  private async hasConfirmation(target: ConfirmTarget): Promise<boolean> {
    return this.perform(() => this.connection.get(SQL.confirmation, ...confirmationKey(target)) !== undefined);
  }

  /**
   * 写节点状态和来历；对现存节点只改动可变行，对新增节点另插入一条正文。
   * @param node 内核给出的最终节点行
   */
  private writeNode(node: CognitionNode): void {
    this.perform(() => {
      const db = this.connection;
      const before = db.get<NodeBefore>(NODE_BEFORE, node.id);
      const mutable = [JSON.stringify(node.origin), node.state ?? null, node.confirmation ?? null,
        node.currentChange?.revisionId ?? null, node.currentChange?.by ?? null,
        node.pruneReason ?? null, node.reviveWhen ?? null];
      if (before !== undefined) {
        if (before.parent_id !== node.parentId) throw new CognitionError('invalid', '已有判断不能改变父节点');
        db.run(`UPDATE nodes SET origin = ?, state = ?, confirmation = ?, change_id = ?, change_by = ?,
          prune_reason = ?, revive_when = ? WHERE id = ?`, ...mutable, node.id);
        if (before.change_id !== null && before.confirmation !== 'humanConfirmed') this.touched.add(before.change_id);
      } else {
        if (node.parentId === null && db.get(ROOT) !== undefined) {
          throw new CognitionError('invalid', '每棵树只能有一个根节点');
        }
        db.run(`INSERT INTO nodes (id, id_key, parent_id, title, origin, state, confirmation, change_id, change_by,
          prune_reason, revive_when) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        node.id, idKey(node.id), node.parentId, node.body.title, ...mutable);
        db.run('INSERT INTO node_bodies (node_id, body) VALUES (?, ?)', node.id, JSON.stringify(node.body));
      }
      if (node.currentChange !== undefined && node.confirmation !== 'humanConfirmed') {
        this.touched.add(node.currentChange.revisionId);
      }
    });
  }

  /**
   * 追加一条引用，重复 ID 不覆盖既有边，端点在提交时由数据库核对。
   * @param ref 内核给出的新引用
   */
  private writeRef(ref: Ref): void {
    this.perform(() => {
      const db = this.connection;
      if (db.get('SELECT 1 FROM refs WHERE id = ?', ref.id) !== undefined) {
        throw new CognitionError('invalid', '引用 ID 已存在');
      }
      db.run(`INSERT INTO refs (id, id_key, from_id, to_node_id, target_doc, target_part, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ref.id, idKey(ref.id), ref.from, ref.target.nodeId ?? null, ref.target.doc ?? null, ref.target.part ?? null, ref.kind);
    });
  }

  /**
   * 追加修订和按节点反查的索引行，保留关联原顺序但不会因重复节点 ID 让时间线重复。
   * @param revision 新修订；已存的修订不更新
   */
  private appendRevision(revision: Revision): void {
    this.perform(() => {
      const db = this.connection;
      if (db.get('SELECT 1 FROM revisions WHERE id = ?', revision.id) !== undefined) {
        throw new CognitionError('invalid', '修订 ID 已存在');
      }
      const order = idKey(revision.id);
      const time = timeKey(revision.at);
      // 史料只有给出明确确认目标才登记查重；不替导入猜测确认对象。
      const [kind, targetId] = revision.detail !== undefined && 'target' in revision.detail
        ? confirmationKey(revision.detail.target) : [null, null];
      db.run(`INSERT INTO revisions (id, id_key, time_key, at, kind, by, summary, node_ids, detail, source,
        confirmed_kind, confirmed_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      revision.id, order, time, revision.at, revision.kind, revision.by, revision.summary, JSON.stringify(revision.nodeIds),
      revision.detail === undefined ? null : JSON.stringify(revision.detail), revision.source ?? null, kind, targetId);
      for (const nodeId of new Set(revision.nodeIds)) {
        db.run('INSERT INTO revision_nodes (node_id, revision_id, time_key, id_key) VALUES (?, ?, ?, ?)',
          nodeId, revision.id, time, order);
      }
      if (this.collectRevisions) this.revisions.push(structuredClone(revision));
    });
  }

  /** work 返回、抛错或宿主关闭后使端口失效；不能再经遗留句柄改动事务。 */
  finish(): void { this.active = false; }

  /**
   * 发布前验证工作未失败，解析根并同步改动涉及的待确认修订键。
   * @returns 树根 ID；树版本和事务本身由存储入口提交
   */
  prepareCommit(): NodeId {
    if (this.failure !== undefined) throw this.failure;
    const db = this.connection;
    const root = db.get<{ id: NodeId }>(ROOT)?.id;
    if (root === undefined) throw new CognitionError('invalid', '自举事务必须写入一个根节点');
    for (const id of this.touched) {
      // 判断集合是否为空只探一条索引行。未动到的节点仍由成员索引保留，无须重扫整组。
      if (db.get(SQL.firstPendingMember, id) === undefined) {
        db.run('DELETE FROM pending_formations WHERE revision_id = ?', id);
      } else {
        if (db.get(`SELECT 1 FROM revisions WHERE id = ? AND kind = 'formation' AND by IN ('human', 'ai')`, id) === undefined) {
          throw new CognitionError('invalid', '未确认索引的当前指针不指向日常形成记录');
        }
        db.run(`INSERT INTO pending_formations (revision_id, by, time_key, id_key)
          SELECT id, by, time_key, id_key FROM revisions WHERE id = ? ON CONFLICT (revision_id) DO NOTHING`, id);
      }
    }
    return root;
  }
}
