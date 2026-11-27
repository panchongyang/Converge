/** 可逆归档的存储标记。日常树行不改写；同一 SQLite 事务更新标记及子树的可见性索引。 */
import { CognitionError } from '@cognition-tree/kernel/types';
import type { Connection } from './connection';

/** 归档入口的轻行；整树没有 nodeId，分支 ID 只在指定树内有意义。 */
export interface ArchiveItem { treeId: string; nodeId?: string; title: string }

/**
 * 点查有效归档状态；树根只标记自己，整树不可读由打开树时单独守护。
 * @param db 已升级至支持归档的当前事务或快照连接
 * @param id 节点 ID，null 和 undefined 表示没有待查端点
 */
export function isArchived(db: Connection, id: string | null | undefined): boolean {
  return id != null && db.get('SELECT 1 FROM node_archive WHERE node_id = ?', id) !== undefined;
}

/**
 * 只查是否有有效隐藏行；调用方先确认根可见，才可把结果解释为是否存在隐藏分支。
 * @param db 已升级至支持归档的当前事务或快照连接
 */
export function hasArchivedBranches(db: Connection): boolean {
  return db.get('SELECT 1 FROM node_archive LIMIT 1') !== undefined;
}

/**
 * 从活动树列出所有显式标记，包括被另一条显式归档的祖先暂时遮住的标记。
 * @param db 已验证活动树的只读快照连接
 * @param treeId 该树已验证的 ID
 */
export function listArchivedBranches(db: Connection, treeId: string): ArchiveItem[] {
  return db.all<{ id: string; title: string }>(`SELECT n.id, n.title FROM node_archive a
    JOIN nodes n ON n.id = a.node_id WHERE a.explicit = 1 ORDER BY n.id_key`)
    .map(({ id, title }) => ({ treeId, nodeId: id, title }));
}

/**
 * 改变显式标记；归档和恢复只遍历这次实际改变可见性的子树，遇到已隐藏子树时保留原标记。
 * @param db 已开始的 SQLite 写事务，归档标记与 stamp 由调用方一起提交
 * @param rootId 树登记指定的实际根节点
 * @param nodeId 要改动的节点，undefined 等同于实际根节点
 * @param archived true 设置显式标记，false 移除它
 * @returns 显式标记确实变化时为 true
 */
export function updateArchive(db: Connection, rootId: string, nodeId: string | undefined, archived: boolean): boolean {
  const id = nodeId ?? rootId;
  const target = db.get<{ parent_id: string | null }>('SELECT parent_id FROM nodes WHERE id = ?', id);
  if (target === undefined || (id !== rootId && isArchived(db, rootId))) {
    throw new CognitionError('missing', '树或节点不存在');
  }
  if (id === rootId && target.parent_id !== null) throw new CognitionError('storage', '已登记的树根不可读');
  const existing = db.get<{ explicit: number }>('SELECT explicit FROM node_archive WHERE node_id = ?', id);
  if (archived === (existing?.explicit === 1)) return false;

  if (archived) {
    if (existing !== undefined) {
      // 已因祖先隐藏：只加自己的显式标记，不重复写后代。
      db.run('UPDATE node_archive SET explicit = 1 WHERE node_id = ?', id);
    } else if (id === rootId) {
      db.run('INSERT INTO node_archive (node_id, explicit) VALUES (?, 1)', id);
    } else {
      db.run(`WITH RECURSIVE affected(node_id) AS (
          SELECT ? UNION ALL
          SELECT n.id FROM affected p JOIN nodes n ON n.parent_id = p.node_id
          WHERE NOT EXISTS (SELECT 1 FROM node_archive a WHERE a.node_id = n.id)
        ) INSERT INTO node_archive (node_id, explicit) SELECT node_id, node_id = ? FROM affected`, id, id);
    }
  } else if (id === rootId) {
    db.run('DELETE FROM node_archive WHERE node_id = ?', id);
  } else if (isArchived(db, target.parent_id)) {
    // 恢复后仍受祖先归档影响；后代的有效隐藏状态未变。
    db.run('UPDATE node_archive SET explicit = 0 WHERE node_id = ?', id);
  } else {
    db.run(`WITH RECURSIVE affected(node_id) AS (
        SELECT ? UNION ALL
        SELECT n.id FROM affected p JOIN nodes n ON n.parent_id = p.node_id
        JOIN node_archive a ON a.node_id = n.id AND a.explicit = 0
      ) DELETE FROM node_archive WHERE node_id IN (SELECT node_id FROM affected)`, id);
  }
  return true;
}
