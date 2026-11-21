/**
 * 内存存储的确认目标去重。
 *
 * 职责：给出确认目标到稳定键的映射，并从修订记录里读出它确认的对象，
 * 供写事务判断“同一目标不重复确认”，以及提交时更新确认索引。
 * 边界：只做结构识别，不判断目标是否仍有效、是否仍指向形成记录；这些由 commands 校验。
 * 协作：transaction.hasConfirmation 用它对照已提交索引与本次追加的记录；
 * commit 把新确认记录登记进去重集合。
 */
import type { ConfirmTarget, Revision } from '../../types';

/**
 * 把确认目标编码成去重键；两种目标共用同一命名空间，避免修订 ID 与节点 ID 相互冒认。
 * @param target 二选一确认目标
 * @returns 去重键
 */
export function confirmationKey(target: ConfirmTarget): string {
  if ('revisionId' in target) return 'revision:' + target.revisionId;
  return 'seed:' + target.seedNodeId;
}

/**
 * 判断两个确认目标是否指向同一对象。
 * @param left 左侧目标
 * @param right 右侧目标
 * @returns 同为目标类型且 ID 相同
 */
export function sameTarget(left: ConfirmTarget, right: ConfirmTarget): boolean {
  return confirmationKey(left) === confirmationKey(right);
}

/**
 * 从一条修订里取出它声明的确认目标；形成记录或结构不完整的导入记录没有目标。
 * @param revision 已提交或本次追加的修订
 * @returns 确认目标；不是确认记录或导入记录缺明细时为 null
 */
export function confirmationTargetOf(revision: Revision): ConfirmTarget | null {
  if (revision.by !== 'import') {
    return revision.kind === 'confirmation' ? revision.detail.target : null;
  }
  const detail = revision.detail;
  if (detail === undefined) return null;
  if ('target' in detail) return detail.target;
  return null;
}
