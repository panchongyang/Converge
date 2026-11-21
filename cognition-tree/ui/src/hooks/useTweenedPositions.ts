/**
 * 让一组点的位置平滑过渡到新目标（布局变化时节点“游”过去，而不是跳过去）。
 * 新出现的点从 spawnFrom 给出的位置（通常是父节点当前位置）长出来。
 */
import { useEffect, useRef, useState } from 'react';

export interface Pt {
  x: number;
  y: number;
}

/**
 * 计算过渡中的位置。
 * @param target 目标位置（按 ID）；引用变化即视为新目标
 * @param spawnFrom 新点的起始位置；返回 undefined 时就地出现
 * @param duration 过渡时长（毫秒）
 * @param reduced 为 true 时直接跳到目标
 * @returns 当前帧的位置
 */
export function useTweenedPositions<P extends Pt>(
  target: Map<string, P>,
  spawnFrom: (id: string, current: Map<string, Pt>) => Pt | undefined,
  duration: number,
  reduced: boolean,
): Map<string, P> {
  const [shown, setShown] = useState<Map<string, P>>(target);
  const shownRef = useRef<Map<string, Pt>>(target);
  const spawnRef = useRef(spawnFrom);
  spawnRef.current = spawnFrom;

  useEffect(() => {
    const from = new Map<string, Pt>();
    for (const [id, p] of target) {
      const cur = shownRef.current.get(id) ?? spawnRef.current(id, shownRef.current) ?? p;
      from.set(id, { x: cur.x, y: cur.y });
    }
    const moving = [...target].some(([id, p]) => {
      const f = from.get(id)!;
      return Math.abs(f.x - p.x) > 0.5 || Math.abs(f.y - p.y) > 0.5;
    });
    if (reduced || !moving) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 4);
      const next = new Map<string, P>();
      for (const [id, p] of target) {
        const f = from.get(id)!;
        next.set(id, { ...p, x: f.x + (p.x - f.x) * e, y: f.y + (p.y - f.y) * e });
      }
      shownRef.current = next;
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced]);

  return shown;
}
