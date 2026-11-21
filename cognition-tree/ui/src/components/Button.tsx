/**
 * 按钮与文字分段选择。按钮的 loading 只表示“这次请求在路上”，文字显示“…”；不提前显示成功。
 * 视觉上仍是文字：没有底色块、胶囊与投影。
 */
import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 语气：primary/confirm 有极细的方框；danger 用土红色文字；ghost 更淡。 */
  variant?: 'default' | 'primary' | 'confirm' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  icon?: IconName;
  /** 只显示图标（需同时给 aria-label）。 */
  iconOnly?: boolean;
  /** 请求进行中：显示“…”并禁用；没有转圈动画。 */
  loading?: boolean;
  /** 作为开关时的按下态。 */
  active?: boolean;
}

/**
 * 通用按钮。
 * @param props 见 ButtonProps；其余属性透传给 button
 */
export function Button(props: ButtonProps) {
  const { variant = 'default', size = 'md', icon, iconOnly, loading, active, className, children, disabled, type, ...rest } = props;
  const cls = [
    'ct-btn',
    variant !== 'default' ? 'ct-btn--' + variant : '',
    size === 'sm' ? 'ct-btn--sm' : '',
    iconOnly ? 'ct-btn--icon' : '',
    active ? 'ct-btn--active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type ?? 'button'} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="ct-btn__loading">…</span> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {!iconOnly && children}
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  title?: string;
  disabled?: boolean;
}

/**
 * 文字分段选择（单选）：当前项加下划线。
 * @param props.value 当前值
 * @param props.options 选项
 * @param props.onChange 选中新值时调用
 * @param props.size 尺寸
 * @param props.ariaLabel 整组的无障碍名称
 */
export function Segmented<T extends string>(props: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: 'md' | 'sm';
  ariaLabel: string;
}) {
  return (
    <div className={'ct-seg' + (props.size === 'sm' ? ' ct-seg--sm' : '')} role="group" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="ct-seg__opt"
          aria-pressed={o.value === props.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={13} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
