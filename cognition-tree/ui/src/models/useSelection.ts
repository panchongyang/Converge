/**
 * 选中状态与回退栈：人沿树或引用走到别处时，仍能一步回到刚才的位置
 * （ARCHITECTURE 的验收场景：切换判断时不丢失位置）。只是阅读状态，不写树。
 */
import { useCallback, useRef, useState } from 'react';
import type { NodeId } from '../types/kernel';

/** 请空间把某个判断带进视野；seq 递增表示一次新请求，是否真的移动由空间按可视区判断。 */
export interface RevealRequest {
  id: NodeId;
  seq: number;
}

/**
 * 建立本次打开页面的阅读位置；不发确认或写入命令。
 * @param initial 从判断卡等入口明确选择的节点；省略时从根问题开始阅读
 * @returns 选中节点、选择/回退函数与“把目标带进视野”的请求
 */
export function useSelection(initial: NodeId | null = null) {
  const [selectedId, setSelectedId] = useState<NodeId | null>(initial);
  const [stack, setStack] = useState<NodeId[]>([]);
  const [reveal, setReveal] = useState<RevealRequest | null>(initial ? { id: initial, seq: 0 } : null);
  const selRef = useRef<NodeId | null>(initial);
  const stackRef = useRef<NodeId[]>([]);
  const seqRef = useRef(0);

  const request = useCallback((id: NodeId) => {
    seqRef.current += 1;
    setReveal({ id, seq: seqRef.current });
  }, []);

  /**
   * 选中一个节点（或取消选中）。
   * @param id 节点 ID；null 取消选中
   * @param opts.reveal 是否请求把目标带进视野：空间会先判断节点与标签是否已在区内，只有出界时才平移
   */
  const select = useCallback(
    (id: NodeId | null, opts?: { reveal?: boolean }) => {
      const prev = selRef.current;
      if (prev && id && prev !== id) {
        stackRef.current = [...stackRef.current.slice(-29), prev];
        setStack(stackRef.current);
      }
      selRef.current = id;
      setSelectedId(id);
      if (id && opts?.reveal) request(id);
    },
    [request],
  );

  /** 回到上一个选中的节点，并请求空间在必要时把它带进视野。 */
  const back = useCallback(() => {
    const s = stackRef.current;
    const prev = s[s.length - 1];
    if (!prev) return;
    stackRef.current = s.slice(0, -1);
    setStack(stackRef.current);
    selRef.current = prev;
    setSelectedId(prev);
    request(prev);
  }, [request]);

  return { selectedId, select, back, canBack: stack.length > 0, previousId: stack[stack.length - 1] ?? null, reveal };
}
