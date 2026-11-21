/**
 * 阅读栏的确认控件与确认预览。
 *
 * 确认前必须看清这次变更做了什么：预览读 readNode.currentChange（执行者、时间、摘要、实际效果），
 * 并把确认目标绑定到这条明确的 revisionId；导入判断没有日常变更时才绑定 seedNodeId。
 * 替代提议不能靠确认触发执行；执行替代本身也不等于人确认（两者分开显示）。
 */
import type { CognitionNode, ConfirmTarget, NodeDetail } from '../../types/kernel';
import { confirmTargetOf } from '../../models/writes';
import { NodeChip, Seal } from '../../components';
import { confirmationLabel, confirmationView, formatAt, revisionActorLabel, stateLabel } from '../../utils/labels';
import './inspector.css';

export interface ConfirmControlProps {
  node: CognitionNode;
  detail: NodeDetail;
  pending: boolean;
  /** 书写时先不允许再开另一个决定。 */
  disabled?: boolean;
  /** 确认预览是否展开。 */
  open: boolean;
  onToggle: () => void;
  /** 替代提议：引出原文后执行替代。 */
  onAccept: () => void;
}

/**
 * 确认程度与入口；预览由 NodePage 在元信息行下渲染。
 * @param props 见 ConfirmControlProps
 */
export function ConfirmControl(props: ConfirmControlProps) {
  const c = confirmationView(props.node);
  if (c === 'humanConfirmed') {
    return (
      <span className="ct-confirmnow">
        <Seal />
        人确认
      </span>
    );
  }
  const proposedReplacement =
    props.node.origin.kind === 'replacement' && props.node.origin.status === 'proposed' && props.node.state !== 'prune';
  const target = confirmTargetOf(props.detail);
  if (!target) {
    return (
      <span className="ct-confirmnow is-unknown">
        <span>确认未载</span>
      </span>
    );
  }
  // 确认只记人确认，不执行替代；未执行的候选也可以先单独确认，或改用“比较后执行替代”。
  return (
    <span className={'ct-confirmnow' + (c === 'proposed' ? ' is-ai' : ' is-unknown')}>
      <span>{confirmationLabel(c)}</span>
      <span className="ct-reader__dot">·</span>
      <button
        type="button"
        className="ct-link"
        disabled={props.pending || props.disabled}
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        {props.pending ? '记下中…' : props.open ? '收起确认' : c === 'proposed' ? '待你确认' : '由你确认'}
      </button>
      {proposedReplacement && (
        <>
          <span className="ct-reader__dot">·</span>
          <button type="button" className="ct-link" disabled={props.disabled} onClick={props.onAccept}>
            比较后执行替代…
          </button>
        </>
      )}
    </span>
  );
}

export interface ConfirmPreviewProps {
  detail: NodeDetail;
  target: ConfirmTarget;
  pending: boolean;
  onClose: () => void;
  onConfirm: (target: ConfirmTarget) => void;
}

/**
 * 确认前的变更预览：执行者、时间、摘要、实际效果与理由；确认目标已经绑定。
 * @param props 见 ConfirmPreviewProps
 */
export function ConfirmPreview(props: ConfirmPreviewProps) {
  const change = props.detail.currentChange;
  const d = change?.detail;
  const reason = d && 'reason' in d ? d.reason : undefined;
  const reviveWhen = d && 'reviveWhen' in d ? d.reviveWhen : undefined;
  const replacement = d && 'replacement' in d ? d.replacement : undefined;
  return (
    <div className="ct-confirmpreview">
      <div className="ct-confirmpreview__head">
        <span>确认这条变更</span>
        <button type="button" className="ct-textbtn" onClick={props.onClose}>
          收起
        </button>
      </div>
      {change ? (
        <>
          <p className="ct-confirmpreview__meta">
            {formatAt(change)} · {revisionActorLabel(change.by)}执行 · <span className="ct-mono">{change.id}</span>
          </p>
          <p className="ct-confirmpreview__summary">{change.summary}</p>
          <ul className="ct-confirmpreview__effects">
            {d?.effects.map((e) => (
              <li key={e.nodeId}>
                <NodeChip id={e.nodeId} />
                {' '}
                {e.beforeState === undefined ? '新增' : stateLabel(e.beforeState)} → {stateLabel(e.afterState)}
              </li>
            ))}
          </ul>
          {reason && <p className="ct-confirmpreview__detail">理由：{reason}</p>}
          {reviveWhen && <p className="ct-confirmpreview__detail">复活条件：{reviveWhen}</p>}
          {replacement && (
            <p className="ct-confirmpreview__detail">
              替代：<NodeChip id={replacement.oldId} /> → <NodeChip id={replacement.newId} />
            </p>
          )}
        </>
      ) : (
        <p className="ct-confirmpreview__summary">导入判断，没有日常变更记录；确认的是它导入时的状态。</p>
      )}
      <p className="ct-confirmpreview__note">确认只记人确认，不改分支状态，也不触发替代。</p>
      <button
        type="button"
        className="ct-textbtn ct-confirmpreview__act"
        disabled={props.pending}
        onClick={() => props.onConfirm(props.target)}
      >
        {props.pending ? '记下中…' : '确认'}
      </button>
    </div>
  );
}
