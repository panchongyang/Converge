/** 确认目标的绑定规则（内核接口单 §3.1）。人的入口由 catalog 把关；这里只校验确认对象。 */
import { CognitionError } from '../types';
import type { CognitionNode, ConfirmTarget, WriteTransaction } from '../types';
import { confirmTarget, invalid, requireNode } from './validation';

/** 确认只作用于仍绑定该目标的实际节点，模型只为这些节点更新确认程度。 */
interface ConfirmationPlan {
  target: ConfirmTarget;
  nodes: CognitionNode[];
  summary: string;
}

/**
 * 校验明确的人确认对象仍有效且未确认；关联历史但未受影响的节点不参与。
 * @param transaction 当前单树事务
 * @param requested 显式选定的形成记录或导入判断，可来自待确认项
 * @returns 规范化目标、当前仍绑定的节点与确认摘要；不改变状态或触发替代
 */
export async function planConfirmation(
  transaction: WriteTransaction,
  requested: ConfirmTarget,
): Promise<ConfirmationPlan> {
  const target = confirmTarget(requested);
  if (target.seedNodeId !== undefined) {
    const node = await requireNode(transaction, target.seedNodeId);
    if (node.currentChange !== undefined) invalid('该导入判断已有日常变更，不能再确认导入版本');
    if (node.confirmation === 'humanConfirmed' || await transaction.hasConfirmation(target)) {
      invalid('该导入判断已确认');
    }
    return { target, nodes: [node], summary: `人确认导入判断 ${node.id}` };
  }

  const revision = await transaction.readRevision(target.revisionId);
  if (revision === null) throw new CognitionError('missing', `修订 ${target.revisionId} 不存在`);
  if (revision.kind !== 'formation' || revision.by === 'import') invalid('只能确认日常变更的形成记录');
  if (await transaction.hasConfirmation(target)) invalid('该形成记录已确认');
  const nodes: CognitionNode[] = [];
  const nodeIds = new Set(revision.detail.effects.map(({ nodeId }) => nodeId));
  for (const id of nodeIds) {
    const node = await requireNode(transaction, id);
    // 若替代两端中一侧已变更，只确认仍指向原执行记录的一侧，不动后来的状态或确认。
    if (node.currentChange?.revisionId === revision.id) nodes.push(node);
  }
  if (nodes.length === 0) invalid('该形成记录已不再是任何受影响节点的当前变更');
  if (nodes.every((node) => node.confirmation === 'humanConfirmed')) invalid('该形成记录已确认');
  return { target, nodes, summary: `人确认形成记录 ${revision.id}（${nodes.map(({ id }) => id).join('、')}）` };
}
