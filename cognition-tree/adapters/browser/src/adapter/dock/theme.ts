/**
 * 浏览器开发坞的外观选择：跟随系统 / 纸本 / 夜读。
 *
 * 选择写在 html 元素和 UI 根的 data-ct-theme 上（两处都生效，CSS 在 tokens.css 里优先于
 * prefers-color-scheme）；localStorage 只记住人的选择。键与测试存储不同，清空测试存储不影响外观。
 */

export type ThemeChoice = 'system' | 'paper' | 'ink';

const THEME_KEY = 'converge.cognition-tree.ui.theme.v1';

/**
 * 读取保存过的外观；没有或值不认识时返回跟随系统。
 */
export function readTheme(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return raw === 'paper' || raw === 'ink' ? raw : 'system';
  } catch {
    return 'system';
  }
}

/**
 * 应用外观：system 时移除显式属性，其余写 data-ct-theme。
 * @param choice 外观选择
 */
export function applyTheme(choice: ThemeChoice): void {
  const targets = [document.documentElement, document.getElementById('root')].filter((el): el is HTMLElement => !!el);
  for (const el of targets) {
    if (choice === 'system') el.removeAttribute('data-ct-theme');
    else el.dataset.ctTheme = choice;
  }
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // 存不了不影响本次页面；外观仍已应用。
  }
}
