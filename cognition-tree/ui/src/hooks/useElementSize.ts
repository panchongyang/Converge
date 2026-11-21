/**
 * 观察一个元素的内容尺寸（ResizeObserver）。通用交互钩子，不认识树。
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * 返回元素引用及其当前尺寸；尺寸变化时触发重渲染。
 * @returns [要挂到元素上的 ref, { width, height }]
 */
export function useElementSize<T extends HTMLElement>(): [RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
