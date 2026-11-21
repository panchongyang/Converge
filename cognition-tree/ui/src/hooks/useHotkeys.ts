/**
 * 全局快捷键。键名小写，组合键写成 "mod+k"（Ctrl 或 ⌘）。
 * 焦点在输入框里时只响应 Escape，避免打字时误触发。
 */
import { useEffect, useRef, type RefObject } from 'react';
import { listenForKeys } from './keyboard-root';

/**
 * 注册一组快捷键。
 * @param anchor 界面挂载元素；只响应其文档或影子树内部的按键
 * @param map 键名 → 处理函数；处理函数被调用时默认动作已被阻止
 * @param enabled 为 false 时暂停响应（例如有模态框打开）
 */
export function useHotkeys(anchor: RefObject<Element>, map: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  const mapRef = useRef(map);
  mapRef.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
      const name = (e.ctrlKey || e.metaKey ? 'mod+' : '') + key;
      if (typing && key !== 'escape') return;
      const fn = mapRef.current[name];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    return listenForKeys(anchor.current, onKey);
  }, [anchor, enabled]);
}
