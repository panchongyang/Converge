/** SQLite 行与内核契约的翻译。空 SQL 列还原为省略字段，JSON 只承担单行的嵌套值。 */
import { CognitionError } from '@cognition-tree/kernel/types';
import type { CognitionNode, ConfirmTarget, NodeRow, Ref, Revision } from '@cognition-tree/kernel/types';
import type { Connection } from './connection';
import { SQL } from './schema';

interface SqlNodeRow {
  id: string;
  parent_id: string | null;
  title: string;
  origin: string;
  state: NonNullable<NodeRow['state']> | null;
  confirmation: NonNullable<NodeRow['confirmation']> | null;
  change_id: string | null;
  change_by: 'human' | 'ai' | null;
}

interface SqlNode extends SqlNodeRow {
  body: string;
  prune_reason: string | null;
  revive_when: string | null;
}

/** 数据库中一条引用的定位和种类。 */
export interface SqlRef {
  id: string;
  from_id: string;
  to_node_id: string | null;
  target_doc: string | null;
  target_part: string | null;
  kind: Ref['kind'];
}

/** 完整修订列。node_ids 原样保存史料关联的顺序和重数，反查表只保存唯一关联。 */
export interface SqlRevision {
  id: string;
  at: string;
  kind: Revision['kind'];
  by: Revision['by'];
  summary: string;
  node_ids: string;
  detail: string | null;
  source: string | null;
}

/** 仅供游标 seek 的键，不需要加载修订全文。 */
export interface RevisionKey {
  id_key: Uint8Array;
  time_key: Uint8Array;
  kind: Revision['kind'];
  by: Revision['by'];
}

/** 主库内唯一已提交树的标记；新格式库未自举时没有这一行。 */
export interface TreeMeta { tree_id: string; root_id: string; stamp: number }

/**
 * 把数据库轻行还原成内核投影，不访问正文表。
 * @param row 轻节点 SQL 投影
 * @returns 省略手稿未载字段的轻行
 */
export function nodeRow(row: SqlNodeRow): NodeRow {
  return {
    id: row.id, parentId: row.parent_id, title: row.title, origin: JSON.parse(row.origin),
    ...(row.state === null ? {} : { state: row.state }),
    ...(row.confirmation === null ? {} : { confirmation: row.confirmation }),
    ...(row.change_id === null || row.change_by === null ? {} : {
      currentChange: { revisionId: row.change_id, by: row.change_by },
    }),
  };
}

/**
 * 按 ID 取一条完整节点，附正文及当下的剪除字段。
 * @param connection 当前事务或快照连接
 * @param id 要查的节点 ID
 * @returns 节点，不存在时为 null
 */
export function readNode(connection: Connection, id: string): CognitionNode | null {
  const row = connection.get<SqlNode>(SQL.node, id);
  if (row === undefined) return null;
  const { title, ...base } = nodeRow(row);
  return {
    ...base,
    body: { ...JSON.parse(row.body), title },
    ...(row.prune_reason === null ? {} : { pruneReason: row.prune_reason }),
    ...(row.revive_when === null ? {} : { reviveWhen: row.revive_when }),
  };
}

/**
 * 按 ID 取一条节点轻行，不访问或解码正文。
 * @param connection 当前快照连接
 * @param id 要查的节点 ID
 * @returns 轻行，不存在时为 null
 */
export function readNodeRow(connection: Connection, id: string): NodeRow | null {
  const row = connection.get<SqlNodeRow>(SQL.nodeRow, id);
  return row === undefined ? null : nodeRow(row);
}

/**
 * 翻译一条引用行，保留原始方向，树内节点和材料定位仍互斥。
 * @param row 单条引用的 SQL 行
 * @returns 引用端口行
 */
export function refRow(row: SqlRef): Ref {
  const part = row.target_part === null ? {} : { part: row.target_part };
  if (row.to_node_id !== null) return { id: row.id, from: row.from_id, kind: row.kind, target: { nodeId: row.to_node_id, ...part } };
  if (row.target_doc === null) throw new CognitionError('storage', '已存引用缺少目标');
  return { id: row.id, from: row.from_id, kind: row.kind, target: { doc: row.target_doc, ...part } };
}

/**
 * 还原一条修订，保留原时区、精度、关联顺序和可选史料来源。
 * @param row 单条修订的 SQL 行
 * @returns 修订端口行
 */
export function revisionRow(row: SqlRevision): Revision {
  return {
    id: row.id, at: row.at, kind: row.kind, by: row.by, summary: row.summary,
    nodeIds: JSON.parse(row.node_ids),
    ...(row.detail === null ? {} : { detail: JSON.parse(row.detail) }),
    ...(row.source === null ? {} : { source: row.source }),
  } as Revision;
}

/**
 * 按 ID 取已追加的修订全文。
 * @param connection 当前事务或快照连接
 * @param id 要查的修订 ID
 * @returns 修订，不存在时为 null
 */
export function readRevision(connection: Connection, id: string): Revision | null {
  const row = connection.get<SqlRevision>(SQL.revision, id);
  return row === undefined ? null : revisionRow(row);
}

/**
 * 把确认目标翻译为双列查重键；两个目标类型不会互相冒认。
 * @param target 形成记录或一条导入判断
 * @returns 类型与该类型下的目标 ID
 */
export function confirmationKey(target: ConfirmTarget): ['revision' | 'seed', string] {
  if (target.revisionId !== undefined && target.seedNodeId === undefined) return ['revision', target.revisionId];
  if (target.seedNodeId !== undefined && target.revisionId === undefined) return ['seed', target.seedNodeId];
  throw new CognitionError('invalid', '确认目标必须是修订或导入判断之一');
}

/**
 * 读取树登记及版本，并拒绝大小写文件名别名指向另一棵树。
 * @param connection 当前事务或快照连接
 * @param treeId 请求对应的域内树 ID
 * @returns 对应的登记行；自举未提交时为 undefined
 */
export function readMeta(connection: Connection, treeId: string): TreeMeta | undefined {
  const meta = connection.get<TreeMeta>(SQL.treeMeta);
  if (meta !== undefined && meta.tree_id !== treeId) throw new CognitionError('invalid', '数据库文件对应另一棵树');
  return meta;
}

/**
 * 点查已登记根的标题；根行缺失或实际有父节点表示此库无法提供有效根摘要。
 * @param connection 持有该树登记读取版本的只读事务
 * @param rootId 已提交的 tree_meta.root_id，不假设等于树 ID
 */
export function readRootQuestion(connection: Connection, rootId: string): string {
  const row = connection.get<{ title: string }>(SQL.rootQuestion, rootId);
  if (typeof row?.title !== 'string') throw new CognitionError('storage', '已登记的树根不可读');
  return row.title;
}
