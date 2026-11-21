/**
 * 设置弹窗：外观与图布局的候选，点一下就生效。
 *
 * 浮在空间之上、点遮罩或按 Esc 关闭；选项立即应用并写进本机偏好（见 utils/preferences）。
 * 这里只呈现候选，不解释设计取舍；候选值本身由偏好模块与 tokens.css 定义。
 */
import type { LayoutMode } from '../../utils/layout';
import type { ThemeChoice } from '../../utils/preferences';
import './settings.css';

/** 外观候选：跟随系统按深浅色在纸本与夜读之间切换。 */
const THEMES: readonly { value: ThemeChoice; name: string; note: string }[] = [
  { value: 'auto', name: '跟随系统', note: '浅色用纸本，深色用夜读' },
  { value: 'paper', name: '纸本', note: '燕麦底，深褐墨' },
  { value: 'ink', name: '夜读', note: '乌木底，暖象牙字' },
  { value: 'celadon', name: '青瓷', note: '冷灰绿底，松墨字' },
  { value: 'sand', name: '暖砂', note: '暖驼底，褐墨字' },
];

/** 图布局候选：三种都由已读节点确定，刷新后位置不变。 */
const LAYOUTS: readonly { value: LayoutMode; name: string; note: string }[] = [
  { value: 'radial', name: '径向', note: '根在中央，判断按层向外生长' },
  { value: 'horizontal', name: '横向树', note: '根在左，逐层向右，像目录树' },
  { value: 'vertical', name: '纵向树', note: '根在上，逐层向下，像组织图' },
];

/**
 * 设置页。
 * @param props.theme 当前外观
 * @param props.layout 当前图布局
 * @param props.onTheme 切换外观；立即生效并记住
 * @param props.onLayout 切换图布局；立即生效并记住
 * @param props.onClose 返回阅读
 */
export function Settings(props: {
  theme: ThemeChoice;
  layout: LayoutMode;
  onTheme: (theme: ThemeChoice) => void;
  onLayout: (layout: LayoutMode) => void;
  onClose: () => void;
}) {
  return (
    <div className="ct-settings-veil" onMouseDown={props.onClose}>
      <div className="ct-settings" role="dialog" aria-modal="true" aria-label="设置" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ct-settings__bar">
          <span className="ct-settings__title">设置</span>
          <button type="button" className="ct-textbtn ct-settings__close" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="ct-settings__body ct-scroll">
          <p className="ct-settings__note">选择立即生效，只记在这台浏览器里；不改变树的内容。</p>

          <section className="ct-settings__group" aria-labelledby="ct-settings-theme">
            <h2 className="ct-settings__label" id="ct-settings-theme">
              外观
            </h2>
            <div className="ct-settings__themes">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={'ct-settings__theme' + (t.value === props.theme ? ' is-on' : '')}
                  aria-pressed={t.value === props.theme}
                  onClick={() => props.onTheme(t.value)}
                >
                  {t.value === 'auto' ? (
                    <span className="ct-settings__swatch is-split" aria-hidden="true">
                      <span data-ct-theme="paper" />
                      <span data-ct-theme="ink" />
                    </span>
                  ) : (
                    <span className="ct-settings__swatch" data-ct-theme={t.value} aria-hidden="true" />
                  )}
                  <span className="ct-settings__text">
                    <span className="ct-settings__name">{t.name}</span>
                    <span className="ct-settings__desc">{t.note}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="ct-settings__group" aria-labelledby="ct-settings-layout">
            <h2 className="ct-settings__label" id="ct-settings-layout">
              图布局
            </h2>
            <div className="ct-settings__rows">
              {LAYOUTS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  className={'ct-settings__row' + (l.value === props.layout ? ' is-on' : '')}
                  aria-pressed={l.value === props.layout}
                  onClick={() => props.onLayout(l.value)}
                >
                  <span className="ct-settings__mark" aria-hidden="true">
                    {l.value === props.layout ? '·' : ''}
                  </span>
                  <span className="ct-settings__name">{l.name}</span>
                  <span className="ct-settings__desc">{l.note}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
