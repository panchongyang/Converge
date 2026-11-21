/**
 * 阅读栏与时间线的按需读取：节点详情（readNode）与修订分页（readHistory）。
 * 都随树版本 stamp 变化重读；读取不写时间线。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeDetail, NodeId, Revision, TreeId } from '../types/kernel';
import type { CognitionClient } from '../types/ports';
import { toUiError, type UiError } from '../utils/errors';

/**
 * 读取一个节点的完整正文。
 * @param client 认知端口
 * @param treeId 当前树
 * @param nodeId 节点；null 时不读
 * @param stamp 当前树版本；变化时重读
 */
export function useNodeDetail(client: CognitionClient, treeId: TreeId, nodeId: NodeId | null, stamp: number) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!nodeId) {
      setDetail(null);
      return;
    }
    let live = true;
    setLoading(true);
    client
      .call('readNode', { treeId, nodeId })
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setError(null);
      })
      .catch((e) => live && setError(toUiError(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [client, treeId, nodeId, stamp]);
  const current = detail && detail.node.id === nodeId ? detail : null;
  return { detail: current, error, loading: loading || (!!nodeId && !current && !error) };
}

/**
 * 分页读取修订（从新到旧）。
 * @param client 认知端口
 * @param treeId 当前树
 * @param nodeId 只看与该节点关联的修订；undefined 表示整棵树
 * @param stamp 当前树版本；变化时从最新一页重读
 * @param pageSize 每页条数
 */
export function useHistory(client: CognitionClient, treeId: TreeId, nodeId: NodeId | undefined, stamp: number, pageSize = 20) {
  const [items, setItems] = useState<Revision[]>([]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const key = useRef(0);

  useEffect(() => {
    const k = ++key.current;
    setLoading(true);
    client
      .call('readHistory', { treeId, nodeId, limit: pageSize })
      .then((page) => {
        if (k !== key.current) return;
        setItems(page.items);
        setNext(page.next);
        setError(null);
      })
      .catch((e) => k === key.current && setError(toUiError(e)))
      .finally(() => k === key.current && setLoading(false));
  }, [client, treeId, nodeId, stamp, pageSize]);

  /** 继续往更早翻一页。 */
  const loadMore = useCallback(() => {
    if (!next) return;
    const k = key.current;
    setLoading(true);
    client
      .call('readHistory', { treeId, nodeId, limit: pageSize, after: next })
      .then((page) => {
        if (k !== key.current) return;
        setItems((list) => [...list, ...page.items]);
        setNext(page.next);
      })
      .catch((e) => k === key.current && setError(toUiError(e)))
      .finally(() => k === key.current && setLoading(false));
  }, [client, treeId, nodeId, pageSize, next]);

  return { items, hasMore: !!next, loadMore, loading, error };
}
