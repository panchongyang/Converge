/**
 * 阅读栏的状态词：点开列出内核允许的去向，只改分支状态，不新增节点、不改正文。
 *
 * - 根问题没有去向；
 * - 已剪：重新启用为留 / 未决（写条件变化）；
 * - 未剪：剪除；留 ↔ 未决（含把状态未载定为留 / 未决），待执行的替代候选不能走这一项。
 */
import type { CognitionNode } from '../../types/kernel';
import { NodeGlyph } from '../../components';
import { stateLabel } from '../../utils/labels';

export interface StateControlProps {
  node: CognitionNode;
  isRoot: boolean;
  open: boolean;
  /** 有写入在路上时不允许再开去向。 */
  pending: boolean;
  /** 待执行的替代候选不能切换留 / 未决（接口单 §3.1 的 setOpenOrKeep 适用条件）。 */
  canSwitch: boolean;
  onToggle: () => void;
  onPrune: () => void;
  onRevive: (state: 'keep' | 'open') => void;
  onSwitch: (state: 'keep' | 'open') => void;
}

/**
 * 状态词与去向。
 * @param props 见 StateControlProps
 */
export function StateControl(props: StateControlProps) {
  const state = props.node.state;
  if (props.isRoot) {
    return (
      <span className="ct-stateword is-static">
        <NodeGlyph state={state} confirmation={null} size={13} />
        {stateLabel(state)}
      </span>
    );
  }
  const target = (label: string, onClick: () => void) => (
    <button type="button" className="ct-stateoptions__opt" onClick={onClick}>
      {label}
    </button>
  );
  return (
    <span className="ct-stateword-wrap">
      <button
        type="button"
        className="ct-stateword"
        disabled={props.pending}
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <NodeGlyph state={state} confirmation={null} size={13} />
        {stateLabel(state)}
      </button>
      {props.open && (
        <span className="ct-stateoptions">
          <span className="ct-stateoptions__current">{stateLabel(state)}</span>
          {state === 'prune' ? (
            <>
              {target('留', () => props.onRevive('keep'))}
              {target('未决', () => props.onRevive('open'))}
            </>
          ) : (
            <>
              <button type="button" className="ct-stateoptions__opt" onClick={props.onPrune}>
                剪
              </button>
              {props.canSwitch && state !== 'keep' && target('留', () => props.onSwitch('keep'))}
              {props.canSwitch && state !== 'open' && target('未决', () => props.onSwitch('open'))}
            </>
          )}
        </span>
      )}
    </span>
  );
}

