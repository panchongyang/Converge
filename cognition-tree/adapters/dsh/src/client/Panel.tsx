/**
 * DSH 主面板：把共享应用壳挂进宿主槽位，但不污染宿主文档。
 *
 * 装配：
 * - 面板用 ShadowRoot 承载。样式来自构建期注入的 `__COGNITION_PANEL_CSS__` 字符串，
 *   只写进本 shadow root，不写 document.head，也不改宿主的全局选择器。
 * - React 来自宿主（`react` / `react-dom` 是宿主 static module），这里只用
 *   `createPortal` 把共享 App 渲染进 shadow 内的容器，不打包第二份 React/ReactDOM。
 * - 键鼠事件在 shadow 内完成；在 host 的冒泡终点截断键盘事件，宿主的 window 快捷键
 *   收不到面板里的按键。共享 UI 自己的快捷键监听挂在挂载根（shadowRoot）上，仍可用。
 *
 * 状态归属：树事实在服务端；本组件只持有“本次打开绑定的会话/视图”和加载/错误状态。
 * 侧栏打开时把当时能定位到的宿主会话冻结下来，先显示该工作区的“全部树”列表，不默认 T1；
 * 选中一棵才进入原三栏。宿主换到另一个会话时回到那个会话的目录，不把上一棵树带过去。
 * 树视图左上角可返回目录（重新挂载并重读目录）；卡片明确跳转仍直接进对应树。
 * 打开旧库由 tree-entry 先 readView(root) 取实际根，不假定根 ID 等于树 ID。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { NodeId, TreeId } from '@cognition-tree/kernel/types';
import { App } from '@cognition-tree/ui/app';
import { createArchiveAccess } from './archive';
import { createCognitionClient } from './transport';
import { initialBinding, jumpChannel, sessionChannel, type JumpIntent, type SessionState } from './session';
import { enterFromDirectory, panelMountKey, rebindForSession } from './tree-entry';
import { DirectoryPanel } from './DirectoryPanel';
import { clearLastTree, readLastTree, writeLastTree } from './last-tree';

/** 绑定来源：目录、卡片明确跳转、手动选择的会话，或目录里明确打开的树。 */
type ViewSource = 'directory' | 'jump' | 'recent' | 'tree' | 'last';

/** 本次显示的视图：treeId 缺省是“全部树”目录，有值才进入原三栏。 */
interface View {
  sessionId: string;
  treeId?: TreeId;
  source: ViewSource;
  /** 明确要选中的节点：创建/打开后用 readView 报告的根，跳转后用卡片节点。 */
  initialNodeId?: NodeId;
  /** 每次显式换树递增；即使树 ID 与初始选中都没变，也强制共享 App 重挂并重新读取。 */
  refresh?: number;
}

/**
 * 计算本次打开应绑定的视图；歧义时要求人重选，不猜，也不默认任何树。
 *
 * 没有明确跳转时，回到这个会话上次打开的那棵树；没有记录、或记录里的树已经不在了，
 * 就显示「全部树」目录（树不存在的错误由共享界面给出回目录入口）。
 */
function initialView(): View | null {
  const native = sessionChannel.get();
  const pending = jumpChannel.current();
  const bound = initialBinding(native, pending);
  if (!bound) return null;
  if (pending) {
    return {
      sessionId: bound.sessionId,
      treeId: bound.treeId,
      source: 'jump',
      ...(pending.nodeId ? { initialNodeId: pending.nodeId } : {}),
    };
  }
  const last = readLastTree(bound.sessionId);
  if (last) return { sessionId: bound.sessionId, treeId: last, source: 'last' };
  return { sessionId: bound.sessionId, source: 'directory' };
}

/** 空状态里的会话重选按钮：只用已知 sessionId，不读路径。 */
function SessionChooser(props: { sessions: readonly string[]; onPick: (sessionId: string) => void }) {
  if (props.sessions.length === 0) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ marginBottom: 6, color: 'var(--ct-ink-3)' }}>选择要显示的已绑定会话：</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {props.sessions.map((sessionId) => (
          <button
            key={sessionId}
            type="button"
            onClick={() => props.onPick(sessionId)}
            style={{
              border: '1px solid var(--ct-line-strong)',
              borderRadius: 'var(--ct-r)',
              padding: '3px 10px',
              background: 'transparent',
              color: 'var(--ct-ink-1)',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            {sessionId.length > 16 ? sessionId.slice(0, 12) + '…' : sessionId}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 没有会话、会话歧义、或客户端创建失败时的可读空状态，仍画在 shadow 内。 */
function PanelMessage(props: { title: string; children: ReactNode; sessions?: readonly string[]; onPick?: (id: string) => void }) {
  return (
    <div
      className="ct-app"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 32,
        background: 'var(--ct-ground)',
        color: 'var(--ct-ink-1)',
        fontFamily: 'var(--ct-sans)',
        fontSize: 'var(--ct-fs-row)',
        lineHeight: 'var(--ct-lh-body)',
      }}
    >
      <div style={{ maxWidth: 460 }}>
        <div style={{ fontFamily: 'var(--ct-serif)', fontSize: 'var(--ct-fs-lead)', marginBottom: 12 }}>
          {props.title}
        </div>
        <div style={{ color: 'var(--ct-ink-2)' }}>{props.children}</div>
        {props.sessions && props.onPick && <SessionChooser sessions={props.sessions} onPick={props.onPick} />}
      </div>
    </div>
  );
}

/** 订阅宿主 session 作用域汇总出的当前会话。 */
function useHostSession(): SessionState {
  const [state, setState] = useState<SessionState>(() => sessionChannel.get());
  useEffect(() => {
    setState(sessionChannel.get());
    return sessionChannel.subscribe(setState);
  }, []);
  return state;
}

/** 订阅最近登记的会话，供无法定位时让人显式重选。 */
function useRecentSessions(): readonly string[] {
  const [recent, setRecent] = useState<readonly string[]>(() => sessionChannel.recentSessions());
  useEffect(
    () =>
      sessionChannel.subscribe(() => {
        setRecent(sessionChannel.recentSessions());
      }),
    [],
  );
  return recent;
}

/**
 * 订阅一次明确的跳转意图。
 * @param native 宿主当前会话状态；唯一会话时只接受发往该会话的跳转
 * @returns 面板要采用的跳转；没有或不可信时为 null
 */
function useJump(native: SessionState): JumpIntent | null {
  const [intent, setIntent] = useState<JumpIntent | null>(null);
  const nativeId = native.status === 'ready' ? native.sessionId : null;
  useEffect(() => {
    /** 只接受与唯一当前会话一致的意图；会话未知/歧义时，卡片上的 sessionId 就是明确选择。 */
    const accept = (next: JumpIntent) => {
      if (nativeId && next.sessionId !== nativeId) return;
      setIntent(next);
    };
    // 面板可能是在卡片点击之后才挂载的：先取一次未消费的意图，再订阅后续点击。
    const pending = jumpChannel.current();
    if (pending) accept(pending);
    return jumpChannel.subscribe(accept);
  }, [nativeId]);
  return intent;
}

/**
 * 把共享样式注入 shadow root；重复挂载不叠加 style。
 * @param root 面板 shadow root
 */
function ensureStyles(root: ShadowRoot): void {
  if (root.querySelector('style[data-ct-panel]')) return;
  const style = document.createElement('style');
  style.dataset.ctPanel = 'true';
  style.textContent = typeof __COGNITION_PANEL_CSS__ === 'string' ? __COGNITION_PANEL_CSS__ : '';
  root.appendChild(style);
}

/** 面板内容：只有已确定会话与树时才创建正式客户端；换树只经当前会话的端口调用。 */
function PanelBody(props: {
  view: View & { treeId: TreeId };
  jump: JumpIntent | null;
  onBackToTrees: () => void;
}) {
  const { view, jump, onBackToTrees } = props;
  const client = useMemo(() => createCognitionClient({ sessionId: view.sessionId }), [view.sessionId]);
  // 归档与恢复只经当前会话的同源端口；独立浏览器入口不传这个端口。
  const archive = useMemo(() => createArchiveAccess({ sessionId: view.sessionId }), [view.sessionId]);
  const initialNodeId = view.initialNodeId ?? jump?.nodeId;
  // 会话/树/要显示的目标变化时重挂，避免沿用上一棵树的选择与读会话。
  // refresh 让“新建当前缺失树”这种树 ID 与目标都没变的情况也重新读一次，
  // 不依赖 SSE 是否已连上或是否漏了通知。
  const appKey = panelMountKey(view, jump);
  return (
    <App
      key={appKey}
      treeId={view.treeId}
      client={client}
      bridge={{}}
      onBackToTrees={onBackToTrees}
      archive={archive}
      {...(initialNodeId ? { initialNodeId } : {})}
    />
  );
}

/**
 * 主面板槽位组件。
 */
export function MainPanel() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const native = useHostSession();
  const recent = useRecentSessions();
  const jump = useJump(native);
  /** 本次打开冻结的会话/视图；卡片跳转或人显式选择可改绑，宿主换会话时回到新会话的目录。 */
  const [view, setView] = useState<View | null>(initialView);

  // 每次成功进入一棵树（目录打开、新建、卡片跳转、恢复上次）都更新记录；
  // 只记树 ID，不记判断内容，也不发往服务端。
  useEffect(() => {
    if (view?.treeId) writeLastTree(view.sessionId, view.treeId);
  }, [view?.treeId, view?.sessionId]);

  useEffect(() => {
    if (!jump) return;
    setView({
      sessionId: jump.sessionId,
      treeId: jump.treeId,
      source: 'jump',
      ...(jump.nodeId ? { initialNodeId: jump.nodeId } : {}),
    });
    jumpChannel.consume(jump);
  }, [jump]);

  // 会话变了就回到新会话的“全部树”目录；同一会话不重挂，保留人打开过的树。
  useEffect(() => {
    const next = rebindForSession(view, native);
    if (next) setView({ ...next, source: 'directory' });
  }, [native, view]);

  /**
   * 目录里打开/新建成功后进入树；只接受仍在同一会话目录的响应，
   * 人已换会话或已在看别的树时丢弃，不把旧结果串进当前视图。
   */
  const enterTree = useCallback((sessionId: string, treeId: TreeId, rootId: NodeId) => {
    setView((cur) => {
      const next = enterFromDirectory(cur, sessionId, treeId, rootId);
      return next ? { ...next, source: 'tree' } : cur;
    });
  }, []);

  /** 树内左上角返回：重新挂载目录并重读，不沿用旧列表；同时忘掉这棵树，下次打开显示目录。 */
  const backToTrees = useCallback(() => {
    setView((cur) => {
      if (!cur) return cur;
      clearLastTree(cur.sessionId);
      return { sessionId: cur.sessionId, source: 'directory' };
    });
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    ensureStyles(root);
    let container = root.querySelector<HTMLElement>('[data-ct-portal]');
    if (!container) {
      container = document.createElement('div');
      container.dataset.ctPortal = 'true';
      container.style.cssText = 'height:100%;min-height:0;display:flex;flex-direction:column;';
      root.appendChild(container);
    }
    setMount(container);
    // 键盘事件在 shadow 内已被共享 UI（挂在 shadowRoot）处理；冒泡到 host 时截断，
    // 宿主 window/document 上的快捷键就不会把面板里的输入当成全局命令。
    const stop = (event: Event) => event.stopPropagation();
    host.addEventListener('keydown', stop);
    host.addEventListener('keypress', stop);
    host.addEventListener('keyup', stop);
    return () => {
      host.removeEventListener('keydown', stop);
      host.removeEventListener('keypress', stop);
      host.removeEventListener('keyup', stop);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      data-cognition-tree-panel=""
      style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      {mount
        ? createPortal(
            view ? (
              <>
                {view.source === 'recent' && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 12px',
                      borderBottom: '1px solid var(--ct-line)',
                      background: 'var(--ct-page)',
                      color: 'var(--ct-ink-3)',
                      fontSize: 'var(--ct-fs-ui)',
                      flex: 'none',
                    }}
                  >
                    <span>
                      本次显示手动选择的会话：
                      {view.sessionId.length > 16 ? view.sessionId.slice(0, 12) + '…' : view.sessionId}
                    </span>
                    <button
                      type="button"
                      onClick={() => setView(null)}
                      style={{
                        marginLeft: 'auto',
                        border: 0,
                        background: 'transparent',
                        color: 'var(--ct-link)',
                        cursor: 'pointer',
                        font: 'inherit',
                      }}
                    >
                      换会话
                    </button>
                  </div>
                )}
                {view.treeId ? (
                  <PanelBody
                    key={view.sessionId + ':' + view.treeId}
                    view={view as View & { treeId: TreeId }}
                    jump={jump}
                    onBackToTrees={backToTrees}
                  />
                ) : (
                  <DirectoryPanel
                    key={view.sessionId}
                    sessionId={view.sessionId}
                    onEnter={(treeId, rootId) => enterTree(view.sessionId, treeId, rootId)}
                  />
                )}
              </>
            ) : (
              <PanelMessage
                title={native.status === 'ambiguous' ? '先选定一个会话' : '认知树随当前会话打开'}
                sessions={recent}
                onPick={(sessionId) => setView({ sessionId, source: 'recent' })}
              >
                {native.status === 'ambiguous'
                  ? '同屏有多个会话，无法判断这张面板该显示哪一个。请从对应会话里的认知树卡片进入，或在下面选一个已绑定会话；面板不会随便挑一个，也不会读取浏览器里的旧数据。'
                  : '请先在左侧打开或新建一个会话，再回到这里。面板不会读取浏览器里的旧数据，也不会用一个无关工作区顶替。'}
              </PanelMessage>
            ),
            mount,
          )
        : null}
    </div>
  );
}
