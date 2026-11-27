/**
 * 共用应用壳：组合空间、大纲、阅读栏、状态行、开发坞、查找与出处。
 *
 * 状态归属：阅读方式、视野参数句、查找、整树时间线、书写区、待看计数与悬停高亮都是阅读状态，
 * 由本组件持有；认知数据只经 useCognition 读投影，写入只有两条路：人的写入（useHumanWrite：决定 / 确认 / 勘误）
 * 与环境的建树入口（新建树或样例导入）。
 * 环境差异只经 AppProps 进入：client / bridge 端口、树入口、可选的样例种子与开发坞。
 *
 * 版式：顶栏高度随字号；三栏并排，1px 细线分隔，不浮在空间上；阅读栏始终在右。字号与左栏、
 * 阅读栏的宽度都由 tokens.css 的令牌按窗口宽度算出；阅读栏、搜索与时间线都在页面内原地展开。
 * 人的决定都在阅读栏原地发生；本组件只把提交结果交给阅读栏显示，不预先改动缓存。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeId } from '../types/kernel';
import type { AppProps, DockContext, TreeChange } from '../types/ports';
import { BUDGETS, DEFAULT_FOCUS_EXPAND, useCognition } from '../models/useCognition';
import { useHumanWrite, type HumanWrite } from '../models/useHumanWrite';
import { pendingNodeIds, usePending } from '../models/usePending';
import { useSelection } from '../models/useSelection';
import { useHotkeys } from '../hooks/useHotkeys';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { ERROR_MEANING, toUiError, type UiError } from '../utils/errors';
import { readPreferences, writePreferences, type Preferences, type ThemeChoice } from '../utils/preferences';
import type { LayoutMode } from '../utils/layout';
import { Settings } from '../modules/settings/Settings';
import { SpaceView, type CameraCommand } from '../modules/space/SpaceView';
import { Outline } from '../modules/outline/Outline';
import { Reader, type WriterState, type WriterType } from '../modules/inspector/Inspector';
import { SearchPalette } from '../modules/search/SearchPalette';
import { ViewBar, type ReadMode } from '../modules/view/ViewPanel';
import { TreeEntry } from '../modules/tree/TreeEntry';
import { ArchiveList } from '../modules/archive/ArchiveList';
import { ARCHIVE_COPY, archiveLanding, isInSubtree } from '../modules/archive/model';
import { TREE_ENTRY_COPY, TREE_GENESIS_COPY, missingTreeTitle } from '../modules/tree/model';
import '../styles/tokens.css';
import '../styles/base.css';
import './app.css';

/** 书写区草稿：按“节点 ID + 决定类型”留在内存里，成功记下后清掉。 */
const writerKey = (id: NodeId, type: WriterType) => id + ':' + type;

/** 阅读方式：空间 + 大纲 / 空间 / 大纲。 */
type Mode = ReadMode;

/**
 * 应用壳。
 * @param props 见 AppProps：树 ID、端口、可选自举与开发坞
 */
export function App(props: AppProps) {
  const { treeId, client, bridge, bootstrap, trees, onBackToTrees, archive, renderDock } = props;
  const reduced = useReducedMotion();
  const appElement = useRef<HTMLDivElement>(null);
  const { selectedId, select: selectRaw, back, clearBack, canBack, previousId, reveal } = useSelection(props.initialNodeId);
  const [arrivals, setArrivals] = useState<Map<NodeId, number>>(() => new Map());

  /** AI 新提议到达时记下时刻，供「待看」排序；读回之后再记，节点已在缓存里。 */
  const onChange = useCallback((change: TreeChange) => {
    for (const r of change.revisions) {
      if (r.by !== 'ai' || r.detail === undefined || !('action' in r.detail) || r.detail.action !== 'addBranch') continue;
      const id = r.nodeIds[0];
      setArrivals((m) => new Map(m).set(id, Date.now()));
    }
  }, []);
  // 有归档端口的 App 才把重连 ready 当作可见性可能变化；独立浏览器保持原样。
  const cog = useCognition(client, treeId, onChange, !!archive);
  const {
    setSpec,
    expandAt,
    ensureNeighborhood,
    reload,
    bootstrap: bootstrapTree,
    pulses,
    resetVisibility,
    visibilityEpoch,
  } = cog;
  const human = useHumanWrite(client, treeId);
  const s = cog.state;
  const spec = cog.spec;
  const rootId = s.rootId;
  const proposalPage = usePending(client, treeId, s.stamp, s.status === 'ready');
  // 回退项可能已归档；不要在新的可见范围中显示旧的跳转路径。
  useEffect(() => { if (visibilityEpoch > 0) clearBack(); }, [visibilityEpoch, clearBack]);

  const [mode, setMode] = useState<Mode>('combo');
  const [dockOpen, setDockOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [treeEntryOpen, setTreeEntryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(readPreferences);
  /** 切换外观/布局：立即生效并写进本机偏好；写不进去也只在本次生效。 */
  const changeTheme = useCallback((theme: ThemeChoice) => {
    setPrefs((cur) => {
      const next = { ...cur, theme };
      writePreferences(next);
      return next;
    });
  }, []);
  const changeLayout = useCallback((layout: LayoutMode) => {
    setPrefs((cur) => {
      const next = { ...cur, layout };
      writePreferences(next);
      return next;
    });
  }, []);
  const [viewOpen, setViewOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [writer, setWriter] = useState<WriterState | null>(null);
  const [hoveredId, setHoveredId] = useState<NodeId | null>(null);
  const [highlightIds, setHighlightIds] = useState<NodeId[]>([]);
  const [camCommand, setCamCommand] = useState<CameraCommand | null>(null);
  const [readerExpanded, setReaderExpanded] = useState(false);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [dismissedError, setDismissedError] = useState<UiError | null>(null);
  const [boot, setBoot] = useState<{ busy: boolean; error: UiError | null }>({ busy: false, error: null });
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archiveRefresh, setArchiveRefresh] = useState(0);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<UiError | null>(null);
  const drafts = useRef(new Map<string, Record<string, string>>());
  /** 打开视野参数句前的视野：Esc 时还原（原生下拉逐项即时生效，Enter 无需再应用）。 */
  const specAtOpen = useRef<typeof spec | null>(null);

  /** 保存当前草稿并关闭书写区。 */
  const closeWriter = useCallback(() => {
    setWriter((w) => {
      if (w) drafts.current.set(writerKey(w.id, w.type), w.values);
      return null;
    });
  }, []);

  /** 选中一个判断：收起书写区与时间线，再交给选中模型；必要时请求空间把目标带进视野。 */
  const select = useCallback(
    (id: NodeId | null, revealMode: boolean | 'pan' = 'pan') => {
      selectRaw(id, { reveal: revealMode !== false });
      setWriter((w) => {
        if (w) drafts.current.set(writerKey(w.id, w.type), w.values);
        return null;
      });
      setTimelineOpen(false);
      setHighlightIds([]);
      setHoveredId(null);
    },
    [selectRaw],
  );

  /** 打开书写区；同一决定再次打开时恢复本次页面里的草稿。 */
  const openWriter = useCallback((id: NodeId, type: WriterType, initial?: Record<string, string>) => {
    setWriter((cur) => {
      if (cur && (cur.id !== id || cur.type !== type)) drafts.current.set(writerKey(cur.id, cur.type), cur.values);
      const key = writerKey(id, type);
      const stored = drafts.current.get(key) ?? initial ?? {};
      return { id, type, values: { ...stored } };
    });
    setTimelineOpen(false);
    setViewOpen(false);
    setModeOpen(false);
  }, []);

  /** 更新书写内容；同时写入草稿，Esc 收回后还能恢复。 */
  const updateWriter = useCallback((values: Record<string, string>) => {
    setWriter((w) => {
      if (!w) return w;
      drafts.current.set(writerKey(w.id, w.type), values);
      return { ...w, values };
    });
  }, []);

  /** 提交人的一次写入；成功后清掉该决定的草稿，勘误再选中新长出的子判断。 */
  const onSubmit = useCallback(
    async (nodeId: NodeId, write: HumanWrite) => {
      const r = await human.write(nodeId, write);
      if (r.ok) {
        setWriter((w) => {
          if (!w || w.id !== nodeId) return w;
          drafts.current.delete(writerKey(w.id, w.type));
          return null;
        });
        if (write.kind === 'addBranch') select(r.id, 'pan');
      }
      return r;
    },
    [human, select],
  );

  /** 打开查找：先收回书写区与内联展开项，避免浮层与书写区叠在一起。 */
  const openSearch = useCallback(() => {
    closeWriter();
    setViewOpen(false);
    setModeOpen(false);
    setSearchOpen(true);
  }, [closeWriter]);

  const openSource = useCallback(
    (doc: string, part?: string) => {
      if (bridge.openSource) void bridge.openSource({ doc, part }).catch(() => undefined);
    },
    [bridge],
  );

  /** 以某个判断为焦点折出局部树；缺省沿用当前参数。 */
  const focusOn = useCallback(
    (id: NodeId) => {
      setSpec({
        kind: 'focus',
        focusId: id,
        expand: spec.kind === 'focus' ? spec.expand : DEFAULT_FOCUS_EXPAND,
        budget: spec.kind === 'focus' ? spec.budget : BUDGETS.medium,
        onLimit: spec.kind === 'focus' ? spec.onLimit : 'fold',
      });
      select(id, true);
    },
    [spec, setSpec, select],
  );

  const changeSpec = useCallback(
    (next: typeof spec) => {
      setDismissedError(null);
      setSpec(next);
    },
    [setSpec],
  );

  const runBootstrap = useCallback(async () => {
    if (!bootstrap) return;
    setBoot({ busy: true, error: null });
    try {
      await bootstrapTree(bootstrap.seed());
      setBoot({ busy: false, error: null });
    } catch (e) {
      setBoot({ busy: false, error: toUiError(e) });
    }
  }, [bootstrap, bootstrapTree]);

  // 换一个判断时清掉上一次的归档失败；同一判断原地重试仍能看到原因。
  useEffect(() => {
    setArchiveError(null);
  }, [selectedId]);

  /** 归档当前判断；根表示整树。成功后分支回到可见祖先，整树返回目录。 */
  const archiveSelected = useCallback(async () => {
    if (!archive || archiveBusy || !rootId) return;
    const id = selectedId ?? rootId;
    setArchiveError(null);
    setArchiveBusy(true);
    try {
      if (id === rootId) {
        // 根即整棵树：归档后面板留在目录，不显示已被隐藏的树。
        if (!onBackToTrees) {
          setArchiveError({ code: 'invalid', message: '当前环境没有可返回的目录，整树归档未提交。' });
          return;
        }
        await archive.archive({ treeId });
        setArchivedOpen(false);
        onBackToTrees?.();
        return;
      }
      await archive.archive({ treeId, nodeId: id });
      // 落点按归档前的可见集合计算；随后丢弃缓存，不能沿用已归档节点的标题与引用。
      const landing = archiveLanding(id, s.known, s.visible, rootId);
      // 归档会改变可见集合；列表重读，新增的归档项才出现。
      setArchiveRefresh((n) => n + 1);
      resetVisibility();
      // 视野若还停在被归档的子树里，跟着落到祖先；focusOn 自身会按新视野重读。
      if (spec.kind === 'focus' && isInSubtree(spec.focusId, id, s.known)) {
        focusOn(landing);
      } else {
        select(landing, 'pan');
        reload();
      }
    } catch (e) {
      setArchiveError(toUiError(e));
    } finally {
      setArchiveBusy(false);
    }
  }, [archive, archiveBusy, rootId, selectedId, treeId, onBackToTrees, s.known, s.visible, select, reload, spec, focusOn, resetVisibility]);

  const toggleTimeline = useCallback(() => {
    closeWriter();
    setViewOpen(false);
    setModeOpen(false);
    setTimelineOpen((v) => !v);
  }, [closeWriter]);

  useHotkeys(
    appElement,
    {
      'mod+k': openSearch,
      '/': openSearch,
      escape: () => {
        closeWriter();
        if (settingsOpen) setSettingsOpen(false);
        else if (treeEntryOpen) setTreeEntryOpen(false);
        else if (searchOpen) setSearchOpen(false);
        else if (timelineOpen) setTimelineOpen(false);
        else if (viewOpen) {
          if (specAtOpen.current) changeSpec(specAtOpen.current);
          setViewOpen(false);
        } else if (modeOpen) setModeOpen(false);
        else if (readerExpanded) {
          setReaderExpanded(false);
          setCollapseSignal((n) => n + 1);
        } else if (selectedId) select(null);
      },
      f: () => setCamCommand((c) => ({ type: 'fit', seq: (c?.seq ?? 0) + 1 })),
      b: () => back(),
      '1': () => setMode('space'),
      '2': () => setMode('combo'),
      '3': () => setMode('outline'),
    },
    s.status === 'ready' && !treeEntryOpen,
  );

  // 有待确认的 AI 变更或导入判断时，顶栏出现「待看」；两类都能定位。
  // 顺序取内核未确认索引（形成记录从新到旧，导入判断在后）；只报已读页数与是否还有更多。
  const proposals = proposalPage.items;
  const proposalIndex = selectedId ? proposals.findIndex((p) => pendingNodeIds(p)[0] === selectedId) : -1;
  const proposalCount = proposals.length + (proposalPage.hasMore ? '+' : '');
  const watchLabel = proposalIndex >= 0 ? proposalIndex + 1 + '/' + proposalCount : proposalCount;
  const cycleProposal = useCallback(() => {
    if (!proposals.length) return;
    const next = proposals[(proposalIndex + 1) % proposals.length];
    select(pendingNodeIds(next)[0], true);
  }, [proposals, proposalIndex, select]);

  // UI 只把 scope / budget 当作还是可续读的边界；exhausted 表示范围内已查尽，不必画芽。
  const boundaries = useMemo(() => s.boundaries.filter((b) => b.kind !== 'exhausted'), [s.boundaries]);
  const scopeCount = boundaries.filter((b) => b.kind === 'scope').length;
  const budgetCount = boundaries.filter((b) => b.kind === 'budget').length;
  const dockCtx: DockContext = useMemo(
    () => ({
      treeId,
      selectedId,
      nodes: s.known,
      select: (id: NodeId) => select(id, true),
    }),
    [treeId, selectedId, s.known, select],
  );
  // 新长出的判断（AI 提议或人勘误）：只用于 300/400ms 的树枝画出与淡入。
  const arrivedIds = useMemo(() => {
    const set = new Set<NodeId>(arrivals.keys());
    for (const pulse of pulses) {
      if (pulse.effect === 'propose' || pulse.effect === 'correct') set.add(pulse.nodeId);
    }
    return set;
  }, [arrivals, pulses]);
  const rootTitle = rootId ? s.known.get(rootId)?.title : undefined;
  const viewError = s.viewError && s.viewError !== dismissedError ? s.viewError : null;
  const viewKey =
    spec.kind === 'panorama'
      ? 'panorama'
      : 'focus:' +
        spec.focusId +
        ':' +
        spec.expand.subtreeDepth +
        ':' +
        spec.expand.jumpHops +
        ':' +
        spec.expand.direction +
        ':' +
        spec.expand.jumpFrom +
        ':' +
        spec.expand.afterJumpDepth +
        ':' +
        spec.budget.maxScans +
        ':' +
        spec.onLimit;

  const dataReady = s.status === 'ready' && !!rootId;
  const outlineProps = dataReady
    ? {
        rootId: rootId!,
        known: s.known,
        visible: s.visible,
        roles: s.roles,
        refs: s.refs,
        boundaries,
        selectedId,
        hoveredId,
        highlightIds,
        onSelect: (id: NodeId) => select(id, 'pan'),
        onHover: setHoveredId,
        onExpand: expandAt,
      }
    : null;

  return (
    <div
      ref={appElement}
      className={'ct-app' + (renderDock ? ' has-dock' : '')}
      data-ct-theme={prefs.theme === 'auto' ? undefined : prefs.theme}
    >
      <header className="ct-top">
        {onBackToTrees && (
          <>
            <button
              type="button"
              className="ct-top__back"
              onClick={onBackToTrees}
              title="返回当前工作区的全部树列表"
            >
              <span className="ct-top__backarrow" aria-hidden="true">
                ←
              </span>
              全部树
            </button>
            <span className="ct-top__vr" aria-hidden="true" />
          </>
        )}
        <span className="ct-top__brand">认知树</span>
        <span className="ct-top__vr" aria-hidden="true" />
        {trees && !onBackToTrees && (
          <button
            type="button"
            className="ct-top__tree"
            onClick={() => setTreeEntryOpen(true)}
            title="打开已知树或新建一棵树"
            aria-haspopup="dialog"
          >
            <span className="ct-top__tree-label">树</span>
            <span className="ct-mono ct-top__tree-id">{treeId}</span>
            <span className="ct-top__tree-act">{TREE_ENTRY_COPY.entry}</span>
          </button>
        )}
        {trees && !onBackToTrees && <span className="ct-top__vr" aria-hidden="true" />}
        {onBackToTrees && (
          <>
            <span className="ct-mono ct-top__treeid" title="当前树 ID">
              {treeId}
            </span>
            <span className="ct-top__vr" aria-hidden="true" />
          </>
        )}
        <span className="ct-top__root" title={rootTitle}>
          {rootTitle ?? ''}
        </span>
        <span className="ct-top__spacer" />
        {dataReady && (
          <div className="ct-top__right">
            {proposals.length > 0 && (
              <button
                type="button"
                className={'ct-top__watch' + (proposalIndex >= 0 ? ' is-on' : '')}
                onClick={cycleProposal}
                title={
                  proposalPage.hasMore
                    ? '依次查看待你确认的 AI 变更与导入判断（已读 ' + proposals.length + ' 条，还有更多）'
                    : '依次查看待你确认的 AI 变更与导入判断'
                }
              >
                待看 <span key={watchLabel} className="ct-top__watchnum">{watchLabel}</span>
              </button>
            )}
            {archive && (
              <button
                type="button"
                className={'ct-top__find' + (archivedOpen ? ' is-on' : '')}
                onClick={() => setArchivedOpen((open) => !open)}
                title={ARCHIVE_COPY.archivedBranchesDesc}
                aria-expanded={archivedOpen}
              >
                {ARCHIVE_COPY.archivedBranches}
              </button>
            )}
            <button type="button" className="ct-top__find" onClick={openSearch} title="查找判断（Ctrl K）">
              查找 <span className="ct-kbd">Ctrl K</span>
            </button>
            <button type="button" className="ct-top__find" onClick={() => setSettingsOpen(true)} title="外观与图布局">
              设置
            </button>
            <button
              type="button"
              className={'ct-top__version ct-mono' + (timelineOpen ? ' is-on' : '')}
              onClick={toggleTimeline}
              title="在阅读栏展开整棵树的时间线"
            >
              v{s.stamp}
            </button>
          </div>
        )}
      </header>

      {archive && archivedOpen && (
        <section className="ct-archivebar" aria-label={ARCHIVE_COPY.archivedBranchesTitle}>
          <ArchiveList
            archive={archive}
            treeId={treeId}
            refreshKey={archiveRefresh}
            onRestored={() => {
              resetVisibility();
              reload();
            }}
          />
          <button type="button" className="ct-textbtn ct-archivebar__close" onClick={() => setArchivedOpen(false)}>
            {ARCHIVE_COPY.close}
          </button>
        </section>
      )}

      <div className={'ct-main is-' + mode}>
        {!dataReady && (
          <div className="ct-center">
            {s.status === 'loading' && <div className="ct-center__text">正在读取认知树…</div>}
            {s.status === 'empty' && (
              <div className="ct-genesis">
                <h1>{trees || onBackToTrees ? missingTreeTitle(treeId) : '这个工作区还没有认知树'}</h1>
                <p>认知树保存判断与依据：为什么这样定、排除过什么、还有什么没定。</p>
                {onBackToTrees ? (
                  <>
                    <p className="ct-genesis__desc">
                      可能是树 ID 不存在，或这棵树属于另一个工作区。回到“全部树”列表刷新目录后重新选择；面板不会用别的会话或浏览器里的旧数据顶替。
                    </p>
                    <button type="button" className="ct-textbtn ct-genesis__action" onClick={onBackToTrees}>
                      ← 全部树
                    </button>
                  </>
                ) : trees ? (
                  <>
                    <p className="ct-genesis__desc">{TREE_GENESIS_COPY.desc}</p>
                    <button type="button" className="ct-textbtn ct-genesis__action" onClick={() => setTreeEntryOpen(true)}>
                      {TREE_GENESIS_COPY.action}
                    </button>
                    <p className="ct-genesis__note">{TREE_GENESIS_COPY.note}</p>
                  </>
                ) : bootstrap ? (
                  <>
                    <p className="ct-genesis__desc">{bootstrap.describe}</p>
                    <button type="button" className="ct-textbtn ct-genesis__action" disabled={boot.busy} onClick={() => void runBootstrap()}>
                      {boot.busy ? '导入中…' : bootstrap.label}
                    </button>
                    <p className="ct-genesis__note">样例导入由人发起，只在树不存在时创建一次，不覆盖已有数据。</p>
                  </>
                ) : (
                  <p className="ct-genesis__note">当前环境没有提供树的创建或打开入口。</p>
                )}
                {boot.error && (
                  <p className="ct-genesis__error">
                    {boot.error.message}。{ERROR_MEANING[boot.error.code] ?? ''}
                  </p>
                )}
              </div>
            )}
            {s.status === 'error' && (
              <div className="ct-genesis">
                <h1>没能读取认知树</h1>
                <p>{s.error?.message}</p>
                <p className="ct-genesis__note">{ERROR_MEANING[s.error?.code ?? 'unknown']}</p>
                <button type="button" className="ct-textbtn ct-genesis__action" onClick={reload}>
                  重试
                </button>
                {onBackToTrees && (
                  <button type="button" className="ct-textbtn ct-genesis__action" onClick={onBackToTrees}>
                    ← 全部树
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {dataReady && (
          <>
            {mode === 'combo' && (
              <aside className="ct-rail" aria-label="大纲">
                {outlineProps && <Outline {...outlineProps} wide={false} />}
              </aside>
            )}
            <main className="ct-workspace">
              {mode === 'outline' ? (
                <div className="ct-workspace__outline">{outlineProps && <Outline {...outlineProps} wide />}</div>
              ) : (
                <SpaceView
                  rootId={rootId!}
                  known={s.known}
                  visible={s.visible}
                  roles={s.roles}
                  refs={s.refs}
                  boundaries={boundaries}
                  selectedId={selectedId}
                  hoveredId={hoveredId}
                  highlightIds={highlightIds}
                  arrivedIds={arrivedIds}
                  viewKey={viewKey}
                  layoutMode={prefs.layout}
                  reveal={reveal}
                  camCommand={camCommand}
                  reducedMotion={reduced}
                  onSelect={(id) => (id ? select(id, 'pan') : select(null))}
                  onHover={setHoveredId}
                  onExpand={expandAt}
                />
              )}
              <ViewBar
                spec={spec}
                selectedId={selectedId}
                rootId={rootId!}
                known={s.known}
                visibleCount={s.visible.size}
                note={
                  s.reading
                    ? '读取中…'
                    : budgetCount > 0
                      ? '预算先到 ' + budgetCount + ' 处'
                      : scopeCount > 0
                        ? '按参数折叠 ' + scopeCount + ' 处'
                        : null
                }
                mode={mode}
                viewOpen={viewOpen}
                modeOpen={modeOpen}
                onToggleView={() => {
                  if (!viewOpen) specAtOpen.current = spec;
                  setViewOpen((v) => !v);
                  setModeOpen(false);
                }}
                onToggleMode={() => {
                  setModeOpen((v) => !v);
                  setViewOpen(false);
                }}
                onMode={(m) => {
                  setMode(m);
                  setModeOpen(false);
                }}
                onSpec={changeSpec}
                onFit={() => setCamCommand((c) => ({ type: 'fit', seq: (c?.seq ?? 0) + 1 }))}
                viewError={viewError}
                onDismissError={() => setDismissedError(viewError)}
              />
            </main>
            <Reader
              key={visibilityEpoch}
              client={client}
              treeId={treeId}
              stamp={s.stamp}
              rootId={rootId!}
              selectedId={selectedId}
              known={s.known}
              refs={s.refs}
              boundaries={boundaries}
              inView={!selectedId || s.visible.has(selectedId)}
              pending={human.pending}
              canBack={canBack}
              previousId={previousId}
              onBack={back}
              onSelect={(id) => select(id, 'pan')}
              onHighlight={setHighlightIds}
              onOpenSource={openSource}
              onFocusView={focusOn}
              ensureNeighborhood={ensureNeighborhood}
              writer={writer}
              onOpenWriter={openWriter}
              onCloseWriter={closeWriter}
              onWriterValues={updateWriter}
              onSubmit={onSubmit}
              onExpand={expandAt}
              timelineOpen={timelineOpen}
              onCloseTimeline={() => setTimelineOpen(false)}
              collapseSignal={collapseSignal}
              onExpandedChange={setReaderExpanded}
              archiveAction={
                archive
                  ? { busy: archiveBusy, error: archiveError, onArchive: () => void archiveSelected() }
                  : undefined
              }
            />
          </>
        )}
      </div>

      {renderDock && (
        <section className={'ct-dock' + (dockOpen ? ' is-open' : '')} aria-label="开发坞">
          <button type="button" className="ct-dock__bar" aria-expanded={dockOpen} onClick={() => setDockOpen((o) => !o)}>
            <span className="ct-dock__title">开发坞</span>
            <span className="ct-dock__hint">AI 模拟器 · 存储与预算 · 外观</span>
            <span className="ct-top__spacer" />
            <span className="ct-dock__toggle">{dockOpen ? '收起' : '展开'}</span>
          </button>
          <div className="ct-dock__body" hidden={!dockOpen}>
            {renderDock(dockCtx)}
          </div>
        </section>
      )}

      {trees && !onBackToTrees && treeEntryOpen && (
        <TreeEntry
          currentTreeId={treeId}
          missing={s.status === 'empty'}
          defaultTreeId={s.status === 'empty' ? treeId : undefined}
          access={trees}
          onClose={() => setTreeEntryOpen(false)}
        />
      )}

      {searchOpen && <SearchPalette known={s.known} onPick={(id) => select(id, true)} onClose={() => setSearchOpen(false)} />}
      {settingsOpen && (
        <Settings
          theme={prefs.theme}
          layout={prefs.layout}
          onTheme={changeTheme}
          onLayout={changeLayout}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
