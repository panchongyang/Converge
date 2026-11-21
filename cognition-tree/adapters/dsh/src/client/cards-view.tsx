/**
 * 宿主聊天区的三个小入口：侧栏图标、当前会话探针、AI 写入卡。
 *
 * 侧栏图标只调用宿主的 panel 选择，不写认知数据。
 * 会话探针是 session 作用域的无可见输出组件：root 作用域的主面板拿不到 sessionId，
 * 由它把宿主当前会话记进进程内通道；面板没有会话时宁可只显示说明，也不猜路径。
 * 写入卡只解释这次调用，并把“查看并追问/去面板确认”翻译成打开面板 + 选中；
 * 确认仍由人在正式阅读栏点击，卡片不调用 confirm，也不改任何无关卡片。
 */
import { useEffect, useId, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { jumpChannel, sessionChannel, type SessionState } from './session';
import { cardActionTarget, readWriteCard, type ToolBlock } from './cards';

/** 卡片动作所需的宿主能力。 */
export interface CardHostProps {
  /** 选中共用主面板；由 index.ts 注入。 */
  openPanel?: () => void;
}

/** toolview 的 owner props 子集（宿主 chat 提供）。 */
export interface ToolCardProps extends CardHostProps {
  block?: ToolBlock;
  toolName?: string;
  /** 该工具调用所属会话；缺失时不提供跳转。 */
  sessionId?: string;
}

/** session 作用域探针的 owner props。 */
export interface SessionProbeProps {
  sessionId?: string;
}

/** 侧栏图标 props。 */
export interface SidebarIconProps {
  size?: number;
}

/** 侧栏图形：三条向上的细枝，沿用共享 UI 的线性画法。 */
export function SidebarIcon(props: SidebarIconProps) {
  const size = props.size || 20;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d="M10 17V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 11 5 6.5M10 9l5-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="5" cy="5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="15" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * 记录当前会话；不渲染可见内容。
 * 每个会话头用自己的来源键登记：同屏多个会话时通道会报 ambiguous，
 * 主面板据此禁用，而不是采用最后挂载的那一个。
 * @param props.sessionId 宿主 session 作用域给出的会话 ID
 */
export function SessionProbe(props: SessionProbeProps): null {
  const { sessionId } = props;
  const source = useId();
  useEffect(() => {
    sessionChannel.attach(source, sessionId);
    return () => sessionChannel.detach(source);
  }, [source, sessionId]);
  return null;
}

/** 订阅当前会话状态，供卡片判断是否属于当前会话。 */
function useSessionState(): SessionState {
  const [state, setState] = useState<SessionState>(() => sessionChannel.get());
  useEffect(() => {
    setState(sessionChannel.get());
    return sessionChannel.subscribe(setState);
  }, []);
  return state;
}

/** 卡片配色使用宿主主题变量；取不到时退回可读的中性色，不写全局样式。 */
const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
  borderRadius: 8,
  padding: '10px 12px',
  margin: '6px 0',
  background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.06))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  font: 'inherit',
  lineHeight: 1.5,
};

const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  marginBottom: 6,
};

const markStyle: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
};

const titleStyle: CSSProperties = {
  fontWeight: 600,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const detailStyle: CSSProperties = {
  margin: '0 0 8px',
  color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.95))',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 96,
  overflow: 'auto',
};

const actionsStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };

const buttonStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.4))',
  borderRadius: 6,
  padding: '2px 10px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: 'var(--dsw-alias-label-primary, currentColor)',
};

const noteStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
};

/**
 * AI 写入工具的聊天卡。
 * @param props.block 宿主 toolview 的调用/结果块
 * @param props.toolName 注册 key 对应的工具名
 * @param props.sessionId 该调用所属会话
 * @param props.openPanel 打开本插件主面板
 */
export function WriteCard(props: ToolCardProps): ReactNode {
  const { block, toolName, sessionId, openPanel } = props;
  // 参数视图会就地增长，必须每次渲染重新读；不能按 block 身份缓存。
  const model = readWriteCard(block, toolName);
  const hostSession = useSessionState();
  if (!model) return null;
  const target = cardActionTarget(model, sessionId);
  // 卡片记录属于它自己的会话；当前会话已明确切走时不给跳转，避免用别的会话代替。
  const sessionReady = !!sessionId && (hostSession.status !== 'ready' || hostSession.sessionId === sessionId);
  const usable = target.open !== null && sessionReady;
  const open = (nodeId?: string) => {
    if (!sessionId || !target.open || !sessionReady) return;
    jumpChannel.request(sessionId, target.open.treeId, nodeId);
    openPanel?.();
  };
  return (
    <div style={cardStyle} data-cognition-tree-card={model.tool}>
      <div style={headStyle}>
        <span style={markStyle}>{model.kind === 'proposal' ? 'AI 提议' : 'AI 变更'}</span>
        <span style={titleStyle} title={model.title}>{model.title}</span>
        <span style={noteStyle}>{model.statusText}</span>
      </div>
      {model.detail && <p style={detailStyle}>{model.detail}</p>}
      <div style={actionsStyle}>
        <button
          type="button"
          style={buttonStyle}
          disabled={!usable}
          onClick={() => open(target.context?.nodeId)}
        >
          查看并追问
        </button>
        {target.focus && (
          <button
            type="button"
            style={primaryButtonStyle}
            title="只打开面板并定位这次变更；确认仍由你在阅读栏点击"
            onClick={() => open(target.focus?.nodeId)}
          >
            去面板确认
          </button>
        )}
      </div>
      {!target.open && (
        <div style={noteStyle}>这条调用没有带齐树与会话信息，只能在聊天里阅读，不会被当成确认。</div>
      )}
      {target.open && !sessionReady && (
        <div style={noteStyle}>这条记录属于另一个会话；请回到那个会话再打开，当前面板不会用它顶替。</div>
      )}
      {model.status === 'failed' && (
        <div style={noteStyle}>失败结果没有写入树；需要的话可先看这次调用的上下文，再让 AI 重试。</div>
      )}
      {usable && !target.focus && model.kind === 'proposal' && model.status === 'succeeded' && (
        <div style={noteStyle}>新判断的稳定 ID 还没回传；面板会打开到它的上下文，确认入口在阅读栏。</div>
      )}
    </div>
  );
}
