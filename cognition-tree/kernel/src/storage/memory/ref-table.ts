/**
 * 内存存储的引用表（接口单 3.3 的 refs 职责中的唯一性部分）。
 *
 * 职责：按引用 ID 记录已提交的边，供写事务判断“引用只增不改”的重复 ID；
 * 出/入向的分批读取走 indexes 的排序索引，不在这里扫描。
 * 边界：只存不可变引用值，不解释引用类型，也不判断目标节点是否存在。
 * 协作：transaction 写引用前查重；commit 成功后登记；snapshot 从索引根读取。
 */
import type { Ref, RefId } from '../../types';

/** 引用 ID 到已提交引用的映射；引用只追加，值本身不变。 */
export class RefTable {
  private readonly byId = new Map<RefId, Ref>();

  /**
   * 判断引用 ID 是否已被占用。
   * @param refId 待查引用 ID
   * @returns 已存在时为 true
   */
  has(refId: RefId): boolean {
    return this.byId.has(refId);
  }

  /**
   * 登记一条已提交引用。
   * @param ref 已提交的不可变引用
   */
  append(ref: Ref): void {
    this.byId.set(ref.id, ref);
  }
}
