/**
 * 通用图标：24×24 描边图标，颜色随 currentColor。只收界面实际用到的少量图标，不引入图标库。
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'check' | 'close' | 'scissors' | 'revive' | 'swap' | 'pencil' | 'focus' | 'clock' | 'branch'
  | 'seal' | 'doc' | 'external' | 'search' | 'spark' | 'orbit' | 'outline' | 'combo' | 'warning'
  | 'info' | 'arrowOut' | 'arrowIn' | 'plus' | 'reset' | 'zoomIn' | 'zoomOut' | 'fit' | 'bolt'
  | 'chevronRight' | 'chevronDown' | 'eye' | 'layers' | 'sliders' | 'robot' | 'user' | 'chain'
  | 'send' | 'seed' | 'dots' | 'home' | 'panel';

const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  scissors: (
    <>
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <path d="M8.2 7.6L20 18M8.2 16.4L20 6" />
    </>
  ),
  revive: (
    <>
      <path d="M12 21v-9" />
      <path d="M12 12c0-4.2 3-6.8 7.4-6.8 0 4.2-3 6.8-7.4 6.8z" />
      <path d="M12 14.5c0-3.2-2.5-5.3-5.8-5.3 0 3.2 2.5 5.3 5.8 5.3z" />
    </>
  ),
  swap: <path d="M7 7.5h12l-3.2-3.2M17 16.5H5l3.2 3.2" />,
  pencil: (
    <>
      <path d="M4 20h4L19.2 8.8l-4-4L4 16v4z" />
      <path d="M13.6 6.4l4 4" />
    </>
  ),
  focus: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v3.4M12 17.8v3.4M2.8 12h3.4M17.8 12h3.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.4V12l3.1 2" />
    </>
  ),
  branch: (
    <>
      <circle cx="6.5" cy="5.5" r="2.1" />
      <circle cx="6.5" cy="18.5" r="2.1" />
      <circle cx="17.5" cy="8.5" r="2.1" />
      <path d="M6.5 7.6v8.8M17.5 10.6c0 3.4-3.4 4.6-9.1 6" />
    </>
  ),
  seal: (
    <>
      <path d="M12 2.8l2.3 1.7 2.8-.2.9 2.7 2.4 1.5-.6 2.8.6 2.8-2.4 1.5-.9 2.7-2.8-.2L12 21.2l-2.3-1.7-2.8.2-.9-2.7-2.4-1.5.6-2.8-.6-2.8 2.4-1.5.9-2.7 2.8.2z" />
      <path d="M8.8 12.1l2.2 2.2 4.3-4.5" />
    </>
  ),
  doc: (
    <>
      <path d="M6.5 3h7.5l4 4v14h-11.5z" />
      <path d="M14 3v4h4M9.3 12h5.8M9.3 15.6h5.8" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.6" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),
  spark: <path d="M12 2.8v4.4M12 16.8v4.4M2.8 12h4.4M16.8 12h4.4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />,
  orbit: (
    <>
      <circle cx="12" cy="12" r="2.5" />
      <ellipse cx="12" cy="12" rx="9.2" ry="4.3" transform="rotate(-28 12 12)" />
      <circle cx="19.4" cy="7.6" r="1" />
    </>
  ),
  outline: <path d="M4 6h3M10 6h10M8 12h3M14 12h6M8 18h3M14 18h6M5.5 6v12h2.5M5.5 12h2.5" />,
  combo: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M9.5 4.5v15M12 9h5.5M12 13h4" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4.2M12 17.2v.3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.2M12 7.8v.3" />
    </>
  ),
  arrowOut: <path d="M5 12h13M13.5 7l5 5-5 5" />,
  arrowIn: <path d="M19 12H6M10.5 7l-5 5 5 5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  reset: (
    <>
      <path d="M4.2 12a7.8 7.8 0 1 0 2.3-5.5" />
      <path d="M4 3.8v4.6h4.6" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="6.6" />
      <path d="M20 20l-4.3-4.3M8.4 11h5.2M11 8.4v5.2" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="6.6" />
      <path d="M20 20l-4.3-4.3M8.4 11h5.2" />
    </>
  ),
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.6 12 5.6 21.5 12 21.5 12 18 18.4 12 18.4 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  layers: (
    <>
      <path d="M12 4l9 5-9 5-9-5z" />
      <path d="M3 14l9 5 9-5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  robot: (
    <>
      <rect x="5" y="8" width="14" height="10.5" rx="3.2" />
      <path d="M12 4.2V8M9.3 13.2h.01M14.7 13.2h.01M3 12.2v3M21 12.2v3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5 20.2c1-4 3.8-6.2 7-6.2s6 2.2 7 6.2" />
    </>
  ),
  chain: (
    <>
      <path d="M10 14l4-4" />
      <path d="M8.6 16.4l-1.1 1.1a3.1 3.1 0 0 1-4.4-4.4l3.1-3.1a3.1 3.1 0 0 1 4.4 0" />
      <path d="M15.4 7.6l1.1-1.1a3.1 3.1 0 0 1 4.4 4.4l-3.1 3.1a3.1 3.1 0 0 1-4.4 0" />
    </>
  ),
  send: (
    <>
      <path d="M4 12.2L20 4l-6 16-2.6-6.4z" />
      <path d="M11.4 13.6L20 4" />
    </>
  ),
  seed: (
    <>
      <path d="M12 21c-4.4 0-7-3.2-7-7.2C5 8.4 12 3 12 3s7 5.4 7 10.8c0 4-2.6 7.2-7 7.2z" />
      <path d="M12 21v-7.5" />
    </>
  ),
  dots: (
    <>
      <circle cx="6" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="18" cy="12" r="1.3" />
    </>
  ),
  home: <path d="M4 11.5L12 4.5l8 7M6.5 9.8V19.5h11V9.8" />,
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M14.5 4.5v15" />
    </>
  ),
};

/**
 * 渲染一个图标（装饰用，对读屏隐藏；需要语义时由外层按钮给 aria-label）。
 * @param props.name 图标名
 * @param props.size 像素尺寸，默认 16
 * @param props.strokeWidth 线宽，默认 1.7
 * @param props.className 额外样式类
 */
export function Icon(props: { name: IconName; size?: number; strokeWidth?: number; className?: string }) {
  const size = props.size ?? 16;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={props.strokeWidth ?? 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={props.className}
      style={{ flex: 'none' }}
    >
      {PATHS[props.name]}
    </svg>
  );
}
