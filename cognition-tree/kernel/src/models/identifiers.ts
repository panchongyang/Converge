/** 树内 ID 分配。只在单树事务里检查候选号，不持有第二份树状态或读取整棵树。 */
import type { NodeId, RefId, RevisionId, WriteTransaction } from '../types';

/**
 * 以原行序生成导入记录 ID；同一时刻的条目仍可按 ID 恢复原行序。
 * @param index 自举数组中的零基索引
 * @returns 新的导入修订 ID，不取代原出处
 */
export function importedRevisionId(index: number): RevisionId {
  return `import-${String(index + 1).padStart(16, '0')}`;
}

/**
 * 在时钟毫秒的命名空间内分配下一条修订；常见情况只需按候选 ID 点查。
 * 同毫秒多笔时指数定位再二分，不从历史第一页扫描。串行写确保并发调用不复用。
 * @param transaction 当前单树事务
 * @param epochMillis 本次形成或确认时刻的毫秒键，不改写修订原时区
 * @returns 不属于现有修订或历史确认目标的新 ID
 */
export async function allocateRevisionId(transaction: WriteTransaction, epochMillis: number): Promise<RevisionId> {
  const prefix = `rev-${epochMillis}-`;
  let low = 0n;
  let high = 1n;
  while (await revisionIdTaken(transaction, numberedId(prefix, high))) {
    low = high;
    high *= 2n;
  }
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    if (await revisionIdTaken(transaction, numberedId(prefix, middle))) low = middle;
    else high = middle;
  }
  return numberedId(prefix, high);
}

/**
 * 按 ID 点查存储；原史料若已用该 ID 作为确认目标，也不把它分给新的修订。
 * @param transaction 当前单树事务
 * @param id 待分配的候选号
 * @returns 该 ID 已有修订记录或被历史确认目标占用时为 true
 */
async function revisionIdTaken(transaction: WriteTransaction, id: RevisionId): Promise<boolean> {
  return await transaction.readRevision(id) !== null || await transaction.hasConfirmation({ revisionId: id });
}

/**
 * 把同一命名空间内的序号编码成可稳定比较的 ID；补齐数字以兼容字符串索引。
 * @param prefix 当前时钟桶的 ID 前缀
 * @param ordinal 树内该命名空间中的正序号
 * @returns 带序号的候选 ID
 */
function numberedId(prefix: string, ordinal: bigint): RevisionId {
  return prefix + ordinal.toString().padStart(16, '0');
}

/**
 * 以创建记录的 ID 为基准分配新节点；遇到手稿已有同名 ID 就点查下一候选，不覆盖。
 * @param transaction 当前单树事务
 * @param revisionId 为本次新增分支保留的形成记录 ID
 * @returns 未被使用的新节点 ID，与其真实父节点无耦合
 */
export async function allocateNodeId(transaction: WriteTransaction, revisionId: RevisionId): Promise<NodeId> {
  const base = `node-${revisionId}`;
  let id = base;
  let suffix = 1;
  while (await transaction.readNode(id) !== null) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

/**
 * 为新节点的出向引用取得一组 ID，用独立命名段降低与任意手稿 ID 相撞的概率。
 * 写端口没有查引用 ID 的入口；最终由只增不改的 writeRef 保证冲突不覆盖、整笔不生效。
 * @param nodeId 已分配的新起点 ID
 * @param count 待创建的出向引用数，同一新节点只调用一次
 * @returns 与草稿边一一对应的候选 ID
 */
export function allocateRefIds(nodeId: NodeId, count: number): RefId[] {
  if (count === 0) return [];
  const nonce = Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  return Array.from({ length: count }, (_, index) => `ref-${nodeId.length}-${nodeId}-${nonce}-${index + 1}`);
}
