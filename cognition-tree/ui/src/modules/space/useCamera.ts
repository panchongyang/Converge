/**
 * 空间视图的镜头：平移、以指针为中心缩放、平移到某个判断与看全。
 *
 * 镜头只是阅读状态；布局不随镜头改变。跳到某个判断时保持缩放、只做平移；
 * 双击推近是唯一会改变缩放的入口。减少动态效果时所有镜头动作直接落位。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

/** 屏幕坐标 = 世界坐标 × k + (x, y)。 */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

/** 空间四周被状态行等占去的边距（px）。 */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 看全用的世界外包框。 */
export interface FitBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const K_MIN = 0.3;
export const K_MAX = 2.2;

const clampK = (k: number) => Math.min(K_MAX, Math.max(K_MIN, k));

/**
 * 镜头状态与操作。
 * @param wheelTarget 接收滚轮缩放的元素
 * @param size 舞台尺寸
 * @param insets 状态行等占去的边距
 * @param reduced 减少动态：镜头动作直接跳到终点
 */
export function useCamera(wheelTarget: RefObject<Element>, size: { width: number; height: number }, insets: Insets, reduced: boolean) {
  const [cam, setCamState] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const camRef = useRef(cam);
  const raf = useRef(0);
  const env = useRef({ size, insets, reduced });
  env.current = { size, insets, reduced };

  const set = useCallback((c: Camera) => {
    camRef.current = c;
    setCamState(c);
  }, []);
  const stop = useCallback(() => cancelAnimationFrame(raf.current), []);

  /** 可视区（扣除状态行后）的屏幕中心。 */
  const center = useCallback(() => {
    const { size: s, insets: i } = env.current;
    return { sx: i.left + (s.width - i.left - i.right) / 2, sy: i.top + (s.height - i.top - i.bottom) / 2 };
  }, []);

  /**
   * 把世界坐标移到可视区中心。
   * @param wx 世界坐标 x
   * @param wy 世界坐标 y
   * @param k 目标缩放；缺省保持当前
   * @param duration 时长（毫秒）；只做平移与（必要时）缩放，不中途拉远
   */
  const centerOn = useCallback(
    (wx: number, wy: number, k?: number, duration = 420) => {
      stop();
      const { sx, sy } = center();
      const from = camRef.current;
      const k1 = clampK(k ?? from.k);
      const to = { x: sx - wx * k1, y: sy - wy * k1, k: k1 };
      if (env.current.reduced || duration <= 0) {
        set(to);
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        const e = 1 - Math.pow(1 - t, 3);
        set({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e });
        if (t < 1) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    },
    [center, set, stop],
  );

  /**
   * 只移动镜头位置，保持当前缩放。
   * @param x 目标镜头 x
   * @param y 目标镜头 y
   * @param duration 时长（毫秒）
   */
  const moveTo = useCallback(
    (x: number, y: number, duration = 420) => {
      stop();
      const from = camRef.current;
      const to = { x, y, k: from.k };
      if (env.current.reduced || duration <= 0) {
        set(to);
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        const e = 1 - Math.pow(1 - t, 3);
        set({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k });
        if (t < 1) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    },
    [set, stop],
  );

  /**
   * 把整片视野装进可视区。
   * @param b 世界坐标外包框
   */
  const fit = useCallback(
    (b: FitBounds) => {
      const { size: s, insets: i } = env.current;
      // 标签字号固定、不随镜头缩放，所以按屏幕像素给四周留出标签余量（横向最多两行 158px，纵向两行）。
      const labelPadX = 172;
      const labelPadY = 58;
      const w = Math.max(200, s.width - i.left - i.right - labelPadX * 2);
      const h = Math.max(180, s.height - i.top - i.bottom - labelPadY * 2);
      const bw = Math.max(1, b.maxX - b.minX);
      const bh = Math.max(1, b.maxY - b.minY);
      const k = clampK(Math.min(w / bw, h / bh, 0.95));
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      centerOn(cx, cy, k, 420);
    },
    [centerOn],
  );

  /**
   * 以某屏幕点为中心缩放。
   * @param factor 缩放倍数（>1 放大）
   * @param at 屏幕坐标；缺省为可视区中心
   */
  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      stop();
      const c = camRef.current;
      const { sx, sy } = center();
      const px = at?.x ?? sx;
      const py = at?.y ?? sy;
      const k = clampK(c.k * factor);
      set({ x: px - (px - c.x) * (k / c.k), y: py - (py - c.y) * (k / c.k), k });
    },
    [center, set, stop],
  );

  useEffect(() => {
    const el = wheelTarget.current;
    if (!el) return;
    const onWheel = (e: Event) => {
      const we = e as WheelEvent;
      we.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(Math.exp(-we.deltaY * (we.deltaMode === 1 ? 0.05 : 0.0016)), { x: we.clientX - r.left, y: we.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wheelTarget, zoomBy]);

  useEffect(() => stop, [stop]);

  return useMemo(() => ({ cam, camRef, set, stop, centerOn, moveTo, fit, zoomBy }), [cam, set, stop, centerOn, moveTo, fit, zoomBy]);
}
