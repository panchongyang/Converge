/**
 * 读取系统“减少动态效果”偏好。开启时，空间视图去掉循环动画和镜头过场，只保留状态变化。
 */
import { useEffect, useState } from 'react';

/** @returns 用户是否要求减少动态效果 */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
