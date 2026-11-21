/**
 * 状态与引用的文字原子件。分支状态与确认程度总是成对、分开显示：
 * “剪 · 人确认”只说明人确认了排除，“留 · AI 提出”也不表示人已同意（见 docs/glossary.md）。
 *
 * 朱印只出现在阅读栏当前判断的元信息行与时间线的「人确认」条目；列表里只标例外（AI 提出）。
 * 确认程度使用显示用的派生值（utils/labels 的 ConfirmationView），不保存旧原型的 aiProposed。
 */
import type { BranchState, NodeId, Origin, RefKind } from '../types/kernel';
import { confirmationLabel, originLabel, REF_KIND, stateLabel, type ConfirmationView } from '../utils/labels';
import { NodeGlyph } from './NodeGlyph';

/**
 * 朱印：一方小小的“人”字印，只在人确认处出现。
 * 边长按 13px 基准换算成界面字号的比例，随令牌一起变化。
 * @param props.size 相对边长，默认 14
 */
export function Seal(props: { size?: number }) {
  const size = props.size ?? 14;
  const em = size / 13;
  return (
    <span
      className="ct-seal"
      style={{
        width: `calc(var(--ct-fs-ui) * ${em})`,
        height: `calc(var(--ct-fs-ui) * ${em})`,
        fontSize: `calc(var(--ct-fs-ui) * ${Math.max(9, size - 4) / 13})`,
      }}
      aria-label="人确认"
    >
      人
    </span>
  );
}

/**
 * 分支状态：符号 + 文字。
 * @param props.state 分支状态；null / 省略为状态未载
 * @param props.showGlyph 是否显示符号，默认显示
 */
export function StateText(props: { state?: BranchState | null; showGlyph?: boolean }) {
  return (
    <span className={'ct-statetext is-' + (props.state ?? 'unknown')}>
      {props.showGlyph !== false && <NodeGlyph state={props.state} confirmation={null} size={13} title={stateLabel(props.state)} />}
      {stateLabel(props.state)}
    </span>
  );
}

/**
 * 确认程度：符号 + 文字；人确认可带朱印（只在阅读栏状态行与时间线用）。
 * @param props.confirmation 显示用的确认程度；null 为确认未载
 * @param props.seal 是否显示朱印，默认不显示
 */
export function ConfirmText(props: { confirmation: ConfirmationView; seal?: boolean }) {
  const c = props.confirmation;
  return (
    <span className={'ct-confirmtext is-' + (c ?? 'unknown')}>
      {c === 'humanConfirmed' && props.seal && <Seal />}
      {c === 'proposed' && <NodeGlyph confirmation={c} size={13} title={confirmationLabel(c)} />}
      {confirmationLabel(c)}
    </span>
  );
}

/**
 * 成对显示分支状态与确认程度（大纲、查找、悬停卡用，不盖朱印）。
 * @param props.state 分支状态
 * @param props.confirmation 显示用的确认程度
 */
export function StatusPair(props: { state?: BranchState | null; confirmation: ConfirmationView }) {
  return (
    <span className="ct-statuspair">
      <StateText state={props.state} />
      <span className="ct-statuspair__dot" aria-hidden="true">
        ·
      </span>
      <ConfirmText confirmation={props.confirmation} />
    </span>
  );
}

/**
 * 节点来历的单字徽记：补 / 勘 / 替；普通分支返回 null。
 * @param props.origin 节点来历
 */
export function OriginMark(props: { origin: Origin }) {
  switch (props.origin.kind) {
    case 'branch':
      return null;
    case 'supplement':
      return <span className="ct-originmark">补</span>;
    case 'erratum':
      return <span className="ct-originmark">勘</span>;
    case 'replacement':
      return <span className="ct-originmark">替</span>;
  }
}

/**
 * 节点来历的小字（补充 / 勘误 / 替代 T…）；普通分支返回 null。
 * @param props.origin 节点来历
 * @param props.onSelect 被替代的 ID 可点时调用
 */
export function OriginText(props: { origin: Origin; onSelect?: (id: NodeId) => void }) {
  const label = originLabel(props.origin);
  if (!label) return null;
  if (props.origin.kind === 'replacement') {
    return (
      <span className="ct-origintext">
        {'替代 '}
        <button type="button" className="ct-chip" onClick={() => props.onSelect?.(props.origin.kind === 'replacement' ? props.origin.replacesId : '')}>
          {props.origin.replacesId}
        </button>
      </span>
    );
  }
  return <span className="ct-origintext">{label}</span>;
}

/**
 * 引用类型：线型样本 + 名称，悬停说明它回答什么问题。
 * @param props.kind 引用类型
 */
export function RefKindSample(props: { kind: RefKind }) {
  const meta = REF_KIND[props.kind];
  return (
    <span className={'ct-refkind is-' + props.kind} title={meta.label + '：' + meta.question}>
      <span className="ct-refkind__line" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/**
 * 稳定 ID；给了 onClick 时可点击跳到该判断。
 * @param props.id 节点 ID
 * @param props.title 可选的悬停说明（例如判断标题）
 * @param props.onClick 点击时调用，参数为节点 ID
 */
export function NodeChip(props: { id: NodeId; title?: string; onClick?: (id: NodeId) => void }) {
  return (
    <button
      type="button"
      className="ct-chip"
      title={props.title ? props.id + ' ' + props.title : props.id}
      onClick={props.onClick ? () => props.onClick?.(props.id) : undefined}
    >
      {props.id}
    </button>
  );
}
