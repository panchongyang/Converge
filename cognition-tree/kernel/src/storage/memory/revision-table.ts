/**
 * 内存存储的修订表（接口单 3.3 的 revisions / revision_nodes 职责中的全文与版本部分）。
 *
 * 职责：按修订 ID 保存追加的修订，并记录写入版本；按版本取修订，
 * 使快照看不到打开之后提交的新记录，同时支持确认目标回查。
 * 时间线与节点历史的分批读取由 indexes 的排序索引服务，这里不扫描。
 * 边界：只追加，不改写旧记录；不解释修订语义，也不维护确认去重索引。
 * 协作：transaction 读已提交修订并追加新记录；commit 登记；snapshot 用 readAt(version)。
 */
import type { Revision, RevisionId } from '../../types';

/** 一条修订及其写入版本。 */
interface RevisionVersion {
  readonly version: number;
  readonly revision: Revision;
}

/** 修订 ID 到已提交修订的映射；修订对象不可变，快照共享同一对象。 */
export class RevisionTable {
  private readonly byId = new Map<RevisionId, RevisionVersion>();

  /**
   * 判断修订 ID 是否已被占用。
   * @param revisionId 待查修订 ID
   * @returns 已存在时为 true
   */
  has(revisionId: RevisionId): boolean {
    return this.byId.has(revisionId);
  }

  /**
   * 取某修订的最新已提交版本。
   * @param revisionId 修订 ID
   * @returns 修订；不存在时为 null
   */
  current(revisionId: RevisionId): Revision | null {
    return this.byId.get(revisionId)?.revision ?? null;
  }

  /**
   * 取某修订在指定快照版本时的内容。
   * @param revisionId 修订 ID
   * @param version 快照固定的提交版本
   * @returns 修订；当时尚未写入时为 null
   */
  readAt(revisionId: RevisionId, version: number): Revision | null {
    const entry = this.byId.get(revisionId);
    if (entry === undefined || entry.version > version) return null;
    return entry.revision;
  }

  /**
   * 追加一条已提交修订。
   * @param revision 已提交的不可变修订
   * @param version 本次提交版本
   */
  append(revision: Revision, version: number): void {
    this.byId.set(revision.id, { version, revision });
  }
}
