/**
 * 人的一次写入（决定 / 确认 / 新分支）的提交状态：进行中、成功、失败。
 *
 * 为什么要一个入口：内核把三类写入分成 addBranch、decideNode、confirm 三个操作，
 * 但它们在阅读栏里共享“记下中 / 没有记下”的交互，也都不在本地预演结果。
 * 提交结果交给阅读栏：成功由读回后的正文与状态说明；失败在书写区下方原地显示原因，
 * 树保持回滚后的状态。写成功只表示已提交，不表示已由人确认。
 */
import { useCallback, useState } from 'react';
import type { NodeId, TreeId } from '../types/kernel';
import type { CognitionClient } from '../types/ports';
import { toUiError, type UiError } from '../utils/errors';
import { addBranchPlacement, type HumanWrite } from './writes';

export type { HumanWrite } from './writes';

/**
 * 一次提交的结果：成功时带内核返回的稳定 ID（节点或修订）；失败时带可显示的原因。
 * 返回 ID 不表示已由人确认。
 */
export type WriteOutcome = { ok: true; id: string } | { ok: false; error: UiError };

/**
 * @param client 认知端口（人侧）
 * @param treeId 当前树
 */
export function useHumanWrite(client: CognitionClient, treeId: TreeId) {
  /** 进行中的写入，形如 "T1.2.4:decision"；没有时为 null。 */
  const [pending, setPending] = useState<string | null>(null);

  /**
   * 提交一次人的写入。
   * @param nodeId 操作对象（确认时也用它标注进行中；确认目标另由 target 给出）
   * @param input 人的明确操作
   * @returns 成功时带内核返回的稳定 ID；失败时带归一化错误；不会抛给调用方
   */
  const write = useCallback(
    async (nodeId: NodeId, input: HumanWrite): Promise<WriteOutcome> => {
      setPending(nodeId + ':' + input.kind);
      try {
        if (input.kind === 'decision') {
          const id = await client.call('decideNode', { treeId, nodeId, decision: input.decision });
          return { ok: true, id };
        }
        if (input.kind === 'confirm') {
          const id = await client.call('confirm', { treeId, target: input.target });
          return { ok: true, id };
        }
        const id = await client.call('addBranch', {
          treeId,
          placement: addBranchPlacement(input.parentId, input.relation),
          draft: input.draft,
        });
        return { ok: true, id };
      } catch (e) {
        return { ok: false, error: toUiError(e) };
      } finally {
        setPending(null);
      }
    },
    [client, treeId],
  );

  return { pending, write };
}

export type HumanWriteModel = ReturnType<typeof useHumanWrite>;
