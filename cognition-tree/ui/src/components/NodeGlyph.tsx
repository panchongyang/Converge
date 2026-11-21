/**
 * 节点徽记：分支状态与确认程度分开画，形状与线型是主编码，颜色只做强化。
 *
 * 符号沿用规格第四节的编码表：
 * - 留：实心墨点；未决：赭石色缺口细环（缺口约 60°）；剪：淡色空心圆加一道斜线；状态未载：很淡的空心小菱形。
 * - 人确认：外轮廓实线；AI 提出：外轮廓铅灰虚线；未确认 / 确认未载：没有外轮廓。
 * 组件只读 currentColor 与 tokens.css 的变量，不写裸色值。
 */
import type { BranchState } from '../types/kernel';
import type { ConfirmationView } from '../utils/labels';

/**
 * 渲染一个节点徽记。
 * @param props.state 分支状态；null 或省略表示手稿未载
 * @param props.confirmation 显示用的确认程度（见 utils/labels 的 confirmationView）
 * @param props.size 像素尺寸，默认 16
 * @param props.title 可选的悬停说明；缺省时使用状态与确认程度的文字
 */
export function NodeGlyph(props: { state?: BranchState | null; confirmation: ConfirmationView; size?: number; title?: string }) {
  const { state, confirmation } = props;
  // 尺寸按 13px 基准换算成列表字号的比例，随令牌一起变大变小；调用点仍可用 size 指定相对大小。
  const size = props.size ?? 16;
  const em = size / 13;
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={props.title ?? '节点状态'}
      style={{ flex: 'none', overflow: 'visible', width: `calc(var(--ct-fs-row) * ${em})`, height: `calc(var(--ct-fs-row) * ${em})` }}
    >
      {confirmation === 'humanConfirmed' && <circle cx="12" cy="12" r="10.2" fill="none" stroke="var(--ct-ink-3)" strokeWidth="0.9" />}
      {confirmation === 'proposed' && (
        <circle cx="12" cy="12" r="10.2" fill="none" stroke="var(--ct-ai)" strokeWidth="1" strokeDasharray="2 2.2" />
      )}
      {state === 'keep' && <circle cx="12" cy="12" r="4.4" fill="var(--ct-keep)" />}
      {state === 'open' && (
        <path
          d="M16.33 9.5 A5 5 0 1 1 12 7"
          fill="none"
          stroke="var(--ct-open)"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      )}
      {state === 'prune' && (
        <>
          <circle cx="12" cy="12" r="5" fill="none" stroke="var(--ct-prune)" strokeWidth="0.9" />
          <path d="M7.6 16.4 L16.4 7.6" stroke="var(--ct-prune)" strokeWidth="0.9" strokeLinecap="round" />
        </>
      )}
      {(state === null || state === undefined) && (
        <path d="M12 7.4 L16.6 12 L12 16.6 L7.4 12 Z" fill="none" stroke="var(--ct-unknown)" strokeWidth="0.9" />
      )}
    </svg>
  );
}
