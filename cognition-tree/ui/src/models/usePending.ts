/**
 * 待确认列表（readUnconfirmed）：UI 只按内核的未确认索引读 [ai, import]，
 * 不从已读节点缓存推断全树的待确认数量。
 *
 * 状态归属：items 是已读到的待确认项；next 是下一页起点；hasMore 表示还有没读的页。
 * UI 只报“已读 N（还有更多）”，不为了得到总数继续翻页——内核也不提供全量计数。
 * 协作：App 用它出「待看 N」；阅读栏按同一索引判断子判断是否待确认。树版本变化时从第一页重读。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmTarget, TreeId } from '../types/kernel';
import type { CognitionClient } from '../types/ports';
import { toUiError, type UiError } from '../utils/errors';
import { emptyPending, mergePendingPage, PENDING_ACTORS, type PendingList } from './pending';

export type {
  RevisionPending,
  SeedPending,
} from './pending';
export { isAiPending, isRevisionPending, pendingNodeIds, pendingTargetOf } from './pending';

/** 一次读取的页大小；待确认索引按页读，扫描量随页大小增长，不随树大小增长。 */
export const PENDING_PAGE = 50;

export interface PendingState extends PendingList {
  loading: boolean;
  error: UiError | null;
}

function initialState(): PendingState {
  return { ...emptyPending(), loading: true, error: null };
}

/**
 * 待确认列表模型。
 * @param client 认知端口（人侧）
 * @param treeId 当前树
 * @param stamp 当前树版本；变化时从第一页重读
 * @param enabled 树已就绪时才读；树还不存在时不发请求（避免把 missing 当错误显示）
 */
export function usePending(client: CognitionClient, treeId: TreeId, stamp: number, enabled = true) {
  const [state, setState] = useState<PendingState>(initialState);
  const seq = useRef(0);

  const readPage = useCallback(
    async (after: ConfirmTarget | undefined, append: boolean) => {
      const k = ++seq.current;
      setState((p) => ({ ...p, loading: true }));
      try {
        const page = await client.call('readUnconfirmed', {
          treeId,
          by: PENDING_ACTORS,
          limit: PENDING_PAGE,
          ...(after ? { after } : {}),
        });
        if (k !== seq.current) return;
        setState((p) => ({ ...mergePendingPage(p, page, append), loading: false, error: null }));
      } catch (e) {
        if (k !== seq.current) return;
        setState((p) => ({ ...p, loading: false, error: toUiError(e) }));
      }
    },
    [client, treeId],
  );

  useEffect(() => {
    if (!enabled) {
      ++seq.current; // 可见性重置后，旧请求不能填回待确认缓存。
      setState({ ...emptyPending(), loading: false, error: null });
      return;
    }
    void readPage(undefined, false);
  }, [readPage, stamp, enabled]);

  /** 继续读下一页；不为了计数自动翻页。 */
  const loadMore = useCallback(() => {
    if (!state.next || state.loading) return;
    void readPage(state.next, true);
  }, [readPage, state.next, state.loading]);

  return { ...state, loadMore };
}

export type PendingModel = ReturnType<typeof usePending>;
