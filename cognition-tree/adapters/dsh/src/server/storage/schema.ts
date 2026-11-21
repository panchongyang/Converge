/** SQLite 文件格式与查询语句；同一份 SQL 用于实际读取与 EXPLAIN 验证。见内核接口单 §3.3。 */

/** 写在主库头中的归属标记（ASCII `CONV`）；不同或未知版本不在原文件上初始化。 */
export const APPLICATION_ID = 0x434f4e56;
export const SCHEMA_VERSION = 1;

// 正文单独存放：轻节点的读取和现存判断的状态更新都不触及正文页。
// 延迟外键容许内核先写节点，再追加该节点指向的修订；直到 COMMIT 才要求关系全部成立。
export const SCHEMA = [
  `CREATE TABLE tree_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tree_id TEXT NOT NULL,
    root_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
    stamp INTEGER NOT NULL CHECK (stamp BETWEEN 1 AND 9007199254740991)
  ) STRICT`,
  `CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    id_key BLOB NOT NULL,
    parent_id TEXT REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
    title TEXT NOT NULL,
    origin TEXT NOT NULL,
    state TEXT,
    confirmation TEXT,
    change_id TEXT REFERENCES revisions(id) DEFERRABLE INITIALLY DEFERRED,
    change_by TEXT,
    prune_reason TEXT,
    revive_when TEXT,
    CHECK ((change_id IS NULL) = (change_by IS NULL)),
    CHECK (change_by IN ('human', 'ai'))
  ) STRICT`,
  `CREATE UNIQUE INDEX nodes_single_root ON nodes (1) WHERE parent_id IS NULL`,
  `CREATE INDEX nodes_children ON nodes (parent_id, id_key)`,
  `CREATE TABLE node_bodies (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id),
    body TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE refs (
    id TEXT PRIMARY KEY,
    id_key BLOB NOT NULL,
    from_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
    to_node_id TEXT REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
    target_doc TEXT,
    target_part TEXT,
    kind TEXT NOT NULL,
    CHECK ((to_node_id IS NULL) <> (target_doc IS NULL))
  ) STRICT`,
  `CREATE INDEX refs_from ON refs (from_id, id_key)`,
  `CREATE INDEX refs_to ON refs (to_node_id, id_key) WHERE to_node_id IS NOT NULL`,
  `CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    id_key BLOB NOT NULL,
    time_key BLOB NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    by TEXT NOT NULL,
    summary TEXT NOT NULL,
    node_ids TEXT NOT NULL,
    detail TEXT,
    source TEXT,
    confirmed_kind TEXT,
    confirmed_id TEXT
  ) STRICT`,
  `CREATE INDEX revisions_time ON revisions (time_key DESC, id_key DESC)`,
  `CREATE INDEX revisions_confirmed ON revisions (confirmed_kind, confirmed_id) WHERE confirmed_id IS NOT NULL`,
  `CREATE TABLE revision_nodes (
    node_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    time_key BLOB NOT NULL,
    id_key BLOB NOT NULL,
    PRIMARY KEY (node_id, revision_id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX revision_nodes_time ON revision_nodes (node_id, time_key DESC, id_key DESC, revision_id)`,
  `CREATE TABLE pending_formations (
    revision_id TEXT PRIMARY KEY REFERENCES revisions(id),
    by TEXT NOT NULL,
    time_key BLOB NOT NULL,
    id_key BLOB NOT NULL
  ) STRICT`,
  `CREATE INDEX pending_formations_seek ON pending_formations (by, time_key DESC, id_key DESC, revision_id)`,
  `CREATE INDEX nodes_pending_members ON nodes (change_id, id_key, id)
    WHERE change_id IS NOT NULL AND confirmation IS NOT 'humanConfirmed'`,
  `CREATE INDEX nodes_pending_imports ON nodes (id_key, id, title)
    WHERE change_id IS NULL AND confirmation = 'unconfirmed'`,
];

/** 轻行只从 nodes 投影元数据，不包含正文表、剪除理由或复活条件。 */
export const NODE_ROW = 'id, parent_id, title, origin, state, confirmation, change_id, change_by';
const REF_ROW = 'id, from_id, to_node_id, target_doc, target_part, kind';
const REVISION_ROW = 'r.id, r.at, r.kind, r.by, r.summary, r.node_ids, r.detail, r.source';
const PENDING_MEMBERS = "change_id = ? AND confirmation IS NOT 'humanConfirmed'";
const PENDING_IMPORTS = "change_id IS NULL AND confirmation = 'unconfirmed'";

/** 实际分页的首页与续页；续页谓词与排序索引同向，不用 OFFSET。 */
export const SQL = {
  treeMeta: 'SELECT tree_id, root_id, stamp FROM tree_meta WHERE singleton = 1',
  rootQuestion: 'SELECT title FROM nodes WHERE id = ? AND parent_id IS NULL',
  node: `SELECT ${NODE_ROW}, prune_reason, revive_when, b.body
    FROM nodes JOIN node_bodies b ON b.node_id = nodes.id WHERE nodes.id = ?`,
  nodeRow: `SELECT ${NODE_ROW} FROM nodes WHERE id = ?`,
  children: [
    `SELECT ${NODE_ROW} FROM nodes WHERE parent_id = ? ORDER BY id_key LIMIT ?`,
    `SELECT ${NODE_ROW} FROM nodes WHERE parent_id = ? AND id_key > ? ORDER BY id_key LIMIT ?`,
  ],
  refsFrom: [
    `SELECT ${REF_ROW} FROM refs WHERE from_id = ? ORDER BY id_key LIMIT ?`,
    `SELECT ${REF_ROW} FROM refs WHERE from_id = ? AND id_key > ? ORDER BY id_key LIMIT ?`,
  ],
  refsTo: [
    `SELECT ${REF_ROW} FROM refs WHERE to_node_id = ? ORDER BY id_key LIMIT ?`,
    `SELECT ${REF_ROW} FROM refs WHERE to_node_id = ? AND id_key > ? ORDER BY id_key LIMIT ?`,
  ],
  revision: `SELECT ${REVISION_ROW} FROM revisions r WHERE r.id = ?`,
  revisionKey: 'SELECT id_key, time_key, kind, by FROM revisions WHERE id = ?',
  confirmation: 'SELECT 1 FROM revisions WHERE confirmed_kind = ? AND confirmed_id = ? LIMIT 1',
  revisions: [
    `SELECT ${REVISION_ROW} FROM revisions r ORDER BY r.time_key DESC, r.id_key DESC LIMIT ?`,
    `SELECT ${REVISION_ROW} FROM revisions r WHERE (r.time_key, r.id_key) < (?, ?)
      ORDER BY r.time_key DESC, r.id_key DESC LIMIT ?`,
  ],
  nodeHistory: [
    `SELECT ${REVISION_ROW} FROM revision_nodes n JOIN revisions r ON r.id = n.revision_id
      WHERE n.node_id = ? ORDER BY n.time_key DESC, n.id_key DESC LIMIT ?`,
    `SELECT ${REVISION_ROW} FROM revision_nodes n JOIN revisions r ON r.id = n.revision_id
      WHERE n.node_id = ? AND (n.time_key, n.id_key) < (?, ?) ORDER BY n.time_key DESC, n.id_key DESC LIMIT ?`,
  ],
  pendingFormations: [
    `SELECT p.revision_id, p.by, p.time_key, p.id_key, r.at, r.summary
      FROM pending_formations p JOIN revisions r ON r.id = p.revision_id
      WHERE p.by = ? ORDER BY p.time_key DESC, p.id_key DESC LIMIT ?`,
    `SELECT p.revision_id, p.by, p.time_key, p.id_key, r.at, r.summary
      FROM pending_formations p JOIN revisions r ON r.id = p.revision_id
      WHERE p.by = ? AND (p.time_key, p.id_key) < (?, ?) ORDER BY p.time_key DESC, p.id_key DESC LIMIT ?`,
  ],
  firstPendingMember: `SELECT 1 FROM nodes WHERE ${PENDING_MEMBERS} LIMIT 1`,
  pendingMembers: `SELECT id FROM nodes WHERE ${PENDING_MEMBERS} ORDER BY id_key`,
  pendingImports: [
    `SELECT id, title FROM nodes WHERE ${PENDING_IMPORTS} ORDER BY id_key LIMIT ?`,
    `SELECT id, title FROM nodes WHERE ${PENDING_IMPORTS} AND id_key > ? ORDER BY id_key LIMIT ?`,
  ],
} as const;
