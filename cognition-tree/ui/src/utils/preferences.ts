/**
 * 界面偏好：外观与图布局，只记在本机浏览器里。
 *
 * 不存判断内容、不写服务端；读不出来的值按缺省处理（跟随系统、径向布局），
 * localStorage 不可用时静默退化为“不记”，不影响树的读写。
 */
import type { LayoutMode } from './layout';

/** 外观选择：跟随系统，或四套固定主题之一。 */
export type ThemeChoice = 'auto' | 'paper' | 'ink' | 'celadon' | 'sand';

/** 一套界面偏好；两个字段互相独立，缺省分别为跟随系统与径向布局。 */
export interface Preferences {
  theme: ThemeChoice;
  layout: LayoutMode;
}

/** 缺省偏好：跟随系统深浅色，图布局用径向。 */
export const DEFAULT_PREFERENCES: Preferences = { theme: 'auto', layout: 'radial' };

/** 存储键；与「上次打开的树」分开，避免一处坏数据影响另一处。 */
const KEY = 'cognition-tree:preferences';

/** 合法的外观与布局值，用来挡掉手改 localStorage 写进来的垃圾。 */
const THEMES: readonly ThemeChoice[] = ['auto', 'paper', 'ink', 'celadon', 'sand'];
const LAYOUTS: readonly LayoutMode[] = ['radial', 'horizontal', 'vertical'];

/** 取浏览器 localStorage；不可用时返回 null。 */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 读偏好；任何一项不合法都只回退该项。
 * @param storage 可选的存储实现；测试用，缺省用浏览器 localStorage
 */
export function readPreferences(storage: Storage | null = defaultStorage()): Preferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_PREFERENCES };
    const value = parsed as Partial<Preferences>;
    const theme = THEMES.includes(value.theme as ThemeChoice) ? (value.theme as ThemeChoice) : DEFAULT_PREFERENCES.theme;
    const layout = LAYOUTS.includes(value.layout as LayoutMode) ? (value.layout as LayoutMode) : DEFAULT_PREFERENCES.layout;
    return { theme, layout };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * 写偏好；写失败（配额、隐私模式）时静默忽略，界面仍按本次选择生效。
 * @param prefs 完整偏好
 * @param storage 可选的存储实现；测试用，缺省用浏览器 localStorage
 */
export function writePreferences(prefs: Preferences, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify({ theme: prefs.theme, layout: prefs.layout }));
  } catch {
    // 存不进去就只在本次生效。
  }
}
