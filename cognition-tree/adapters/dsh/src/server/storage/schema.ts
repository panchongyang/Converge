/** SQLite 文件格式与查询语句；同一份 SQL 用于实际读取与 EXPLAIN 验证。见内核接口单 §3.3。 */

/** 写在主库头中的归属标记（ASCII `CONV`）；不同或未知版本不在原文件上初始化。 */
export const APPLICATION_ID = 0x434f4e56;
export const LEGACY_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION = 2;

// 正文单独存放：轻节点的读取和现存判断的状态更新都不触及正文页。
// 延迟外键容许内核先写节点，再追加该节点指向的修订；直到 COMMIT 才要求关系全部成立。
export const LEGACY_SCHEMA = [
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

/** v2 只新增结构；旧行不改写。隐式行表示因祖先的标记而归档，根标记不展开。 */
export const ARCHIVE_SCHEMA = [
  `CREATE TABLE node_archive (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id),
    explicit INTEGER NOT NULL CHECK (explicit IN (0, 1))
  ) STRICT, WITHOUT ROWID`,
  `CREATE INDEX node_archive_explicit ON node_archive (node_id) WHERE explicit = 1`,
  `CREATE INDEX revision_nodes_revision ON revision_nodes (revision_id, node_id)`,
];
export const SCHEMA = [...LEGACY_SCHEMA, ...ARCHIVE_SCHEMA];
export type SchemaVersion = typeof LEGACY_SCHEMA_VERSION | typeof SCHEMA_VERSION;

/** 轻行只从 nodes 投影元数据，不包含正文表、剪除理由或复活条件。 */
export const NODE_ROW = 'id, parent_id, title, origin, state, confirmation, change_id, change_by';
const REF_ROW = 'id, from_id, to_node_id, target_doc, target_part, kind';
const REVISION_ROW = 'r.id, r.at, r.kind, r.by, r.summary, r.node_ids, r.detail, r.source';
const PENDING_MEMBERS = "change_id = ? AND confirmation IS NOT 'humanConfirmed'";
const PENDING_IMPORTS = "change_id IS NULL AND confirmation = 'unconfirmed'";

/** 生成单个端点的隐藏谓词；expr 是调用方固定的 SQL 表达式，不取自请求。 */
function hiddenNode(expr: string): string {
  return `EXISTS (SELECT 1 FROM node_archive a WHERE a.node_id = ${expr})`;
}

/**
 * 检查修订中所有直接的结构化节点关联；导入记录的明细可比 nodeIds 多引用其它节点。
 * @param r 固定的修订表别名
 */
function mentionsHiddenNode(r: string): string {
  return `EXISTS (SELECT 1 FROM revision_nodes rn JOIN node_archive a ON a.node_id = rn.node_id
      WHERE rn.revision_id = ${r}.id)
    OR (${r}.confirmed_kind = 'seed' AND ${hiddenNode(`${r}.confirmed_id`)})
    OR EXISTS (SELECT 1 FROM json_each(${r}.detail, '$.effects') e JOIN node_archive a
      ON a.node_id = json_extract(e.value, '$.nodeId'))
    OR ${hiddenNode(`json_extract(${r}.detail, '$.replacement.oldId')`)}
    OR ${hiddenNode(`json_extract(${r}.detail, '$.replacement.newId')`)}`;
}

/**
 * 混合修订整体不显示，避免截断效果或只确认替代的一端。确认记录也不能泄露隐藏修订的 ID。
 * @param r 固定的修订表别名；导入史料若形成目标链，UNION 保证遇到环也能结束
 */
function hiddenRevision(r: string): string {
  return `(${mentionsHiddenNode(r)} OR (${r}.confirmed_kind = 'revision' AND EXISTS (
    WITH RECURSIVE targets(id) AS (
      SELECT ${r}.confirmed_id UNION
      SELECT q.confirmed_id FROM targets t JOIN revisions q ON q.id = t.id
      WHERE q.confirmed_kind = 'revision' AND q.confirmed_id IS NOT NULL
    ) SELECT 1 FROM targets t JOIN revisions q ON q.id = t.id WHERE ${mentionsHiddenNode('q')}
  )))`;
}

// 普通投影不改变保存的来历或指针。Origin 的替代分支必须携带旧 ID，因此仅在展示时退回普通分支。
const ARCHIVE_NODE_ROW = `id, parent_id, title,
  CASE WHEN json_extract(origin, '$.kind') = 'replacement' AND ${hiddenNode("json_extract(origin, '$.replacesId')")}
    THEN '{"kind":"branch"}' ELSE origin END AS origin,
  state, confirmation,
  CASE WHEN change_id IS NOT NULL AND EXISTS (SELECT 1 FROM revisions r
    WHERE r.id = change_id AND ${hiddenRevision('r')}) THEN NULL ELSE change_id END AS change_id,
  change_by`;

/**
 * 生成真实 seek 查询；没有隐藏分支的库（含旧库）保持简单索引路径。
 * @param filter 有隐藏分支时启用过滤，所有范围条件位于 LIMIT 前
 */
function readQueries(filter: boolean) {
  const nodeProjection = filter ? ARCHIVE_NODE_ROW : NODE_ROW;
  /** 把过滤附到已有 WHERE；expr 只接受本模块固定的谓词。 */
  const guard = (expr: string) => filter ? ` AND ${expr}` : '';
  const node = guard(`NOT ${hiddenNode('nodes.id')}`);
  const refs = guard(`NOT ${hiddenNode('refs.from_id')} AND NOT ${hiddenNode('refs.to_node_id')}`);
  const visibleRevision = `NOT ${hiddenRevision('r')}`;
  const revision = guard(visibleRevision);
  const pending = guard(`${visibleRevision} AND EXISTS (SELECT 1 FROM nodes
    WHERE change_id = p.revision_id AND confirmation IS NOT 'humanConfirmed' AND NOT ${hiddenNode('nodes.id')})`);
  return {
    node: `SELECT ${nodeProjection}, prune_reason, revive_when, b.body
      FROM nodes JOIN node_bodies b ON b.node_id = nodes.id WHERE nodes.id = ?${node}`,
    nodeRow: `SELECT ${nodeProjection} FROM nodes WHERE id = ?${node}`,
    children: [
      `SELECT ${nodeProjection} FROM nodes WHERE parent_id = ?${node} ORDER BY id_key LIMIT ?`,
      `SELECT ${nodeProjection} FROM nodes WHERE parent_id = ? AND id_key > ?${node} ORDER BY id_key LIMIT ?`,
    ],
    refsFrom: [
      `SELECT ${REF_ROW} FROM refs WHERE from_id = ?${refs} ORDER BY id_key LIMIT ?`,
      `SELECT ${REF_ROW} FROM refs WHERE from_id = ? AND id_key > ?${refs} ORDER BY id_key LIMIT ?`,
    ],
    refsTo: [
      `SELECT ${REF_ROW} FROM refs WHERE to_node_id = ?${refs} ORDER BY id_key LIMIT ?`,
      `SELECT ${REF_ROW} FROM refs WHERE to_node_id = ? AND id_key > ?${refs} ORDER BY id_key LIMIT ?`,
    ],
    revision: `SELECT ${REVISION_ROW} FROM revisions r WHERE r.id = ?${revision}`,
    revisionKey: `SELECT id_key, time_key, kind, by FROM revisions r WHERE id = ?${revision}`,
    revisions: [
      `SELECT ${REVISION_ROW} FROM revisions r${filter ? ` WHERE ${visibleRevision}` : ''}
        ORDER BY r.time_key DESC, r.id_key DESC LIMIT ?`,
      `SELECT ${REVISION_ROW} FROM revisions r WHERE (r.time_key, r.id_key) < (?, ?)${revision}
        ORDER BY r.time_key DESC, r.id_key DESC LIMIT ?`,
    ],
    nodeHistory: [
      `SELECT ${REVISION_ROW} FROM revision_nodes n JOIN revisions r ON r.id = n.revision_id
        WHERE n.node_id = ?${revision} ORDER BY n.time_key DESC, n.id_key DESC LIMIT ?`,
      `SELECT ${REVISION_ROW} FROM revision_nodes n JOIN revisions r ON r.id = n.revision_id
        WHERE n.node_id = ? AND (n.time_key, n.id_key) < (?, ?)${revision} ORDER BY n.time_key DESC, n.id_key DESC LIMIT ?`,
    ],
    pendingFormations: [
      `SELECT p.revision_id, p.by, p.time_key, p.id_key, r.at, r.summary
        FROM pending_formations p JOIN revisions r ON r.id = p.revision_id
        WHERE p.by = ?${pending} ORDER BY p.time_key DESC, p.id_key DESC LIMIT ?`,
      `SELECT p.revision_id, p.by, p.time_key, p.id_key, r.at, r.summary
        FROM pending_formations p JOIN revisions r ON r.id = p.revision_id
        WHERE p.by = ? AND (p.time_key, p.id_key) < (?, ?)${pending} ORDER BY p.time_key DESC, p.id_key DESC LIMIT ?`,
    ],
    pendingMembers: `SELECT id FROM nodes WHERE ${PENDING_MEMBERS}${node} ORDER BY id_key`,
    pendingImports: [
      `SELECT id, title FROM nodes WHERE ${PENDING_IMPORTS}${node} ORDER BY id_key LIMIT ?`,
      `SELECT id, title FROM nodes WHERE ${PENDING_IMPORTS} AND id_key > ?${node} ORDER BY id_key LIMIT ?`,
    ],
  } as const;
}

/** 实际分页的首页与续页；续页谓词与排序索引同向，不用 OFFSET。 */
export const SQL = {
  ...readQueries(false),
  treeMeta: 'SELECT tree_id, root_id, stamp FROM tree_meta WHERE singleton = 1',
  rootQuestion: 'SELECT title FROM nodes WHERE id = ? AND parent_id IS NULL',
  confirmation: 'SELECT 1 FROM revisions WHERE confirmed_kind = ? AND confirmed_id = ? LIMIT 1',
  firstPendingMember: `SELECT 1 FROM nodes WHERE ${PENDING_MEMBERS} LIMIT 1`,
} as const;
export const VISIBLE_SQL = readQueries(true);
export type ReadSql = ReturnType<typeof readQueries>;
