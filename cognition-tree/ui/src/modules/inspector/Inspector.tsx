/**
 * 阅读栏：一个判断的一页，也是人的决定发生的唯一位置。
 *
 * 读：正文用 readNode 按需取；推导链、子判断与引用来自已读缓存，选中时补读一层邻居。
 * 写：状态词、确认预览、新增子判断 / 补充 / 勘误入口都在文字旁原地长出书写区，
 * 没有保存/取消按钮；Ctrl ↵ 记下，Esc 收回。确认先展示 readNode.currentChange 的内容，
 * 并把目标绑定到那条明确的 revisionId。
 * 记下之前不预演结果：元信息写“当前 → 目标（未记下）”，树与空间都不变；失败原因写在书写区下方。
 * 成功后的状态以 watch 读回为准，这里不预先改动缓存。整棵树的时间线也在此原地展开。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listenForKeys } from '../../hooks/keyboard-root';
import type {
  Boundary,
  CognitionNode,
  ConfirmTarget,
  NodeDetail,
  NodeId,
  Ref,
  RefId,
  TreeId,
  ViewNode,
} from '../../types/kernel';
import type { CognitionClient } from '../../types/ports';
import type { HumanWrite, WriteOutcome } from '../../models/useHumanWrite';
import { confirmTargetOf } from '../../models/writes';
import { useHistory, useNodeDetail } from '../../models/useNodeReads';
import { compareIds } from '../../utils/ids';
import { confirmationLabel, confirmationView, isAiProposed, originMark, partLabel, stateLabel } from '../../utils/labels';
import type { UiError } from '../../utils/errors';
import { Button, CopyId, NodeChip, NodeGlyph, OriginMark, OriginText, RefKindSample, RichText } from '../../components';
import { ARCHIVE_COPY } from '../archive/model';
import { Timeline } from '../timeline/Timeline';
import { ConfirmControl, ConfirmPreview } from './ConfirmControl';
import { StateControl } from './StateControl';
import {
  BRANCH_WRITER_LABEL,
  isBranchWriter,
  missingWriterFields,
  writeFromWriter,
  WRITER_CONFIG,
  type WriterType,
} from './writer';
import './inspector.css';

export type { WriterType } from './writer';

/** 正在书写的一次写入；内容按节点与写入类型留在内存里，成功记下后由 App 清掉。 */
export interface WriterState {
  id: NodeId;
  type: WriterType;
  values: Record<string, string>;
}

export interface ReaderProps {
  client: CognitionClient;
  treeId: TreeId;
  stamp: number;
  rootId: NodeId;
  selectedId: NodeId | null;
  known: Map<NodeId, ViewNode>;
  refs: Map<RefId, Ref>;
  boundaries: Boundary[];
  /** 正在书写的一次写入；null 表示没有。 */
  writer: WriterState | null;
  /** 选中的判断是否在当前视野里。 */
  inView: boolean;
  /** useHumanWrite 的进行中标记（nodeId:写入类型）。 */
  pending: string | null;
  canBack: boolean;
  previousId: NodeId | null;
  onBack: () => void;
  onSelect: (id: NodeId) => void;
  onHighlight: (ids: NodeId[]) => void;
  onOpenSource: (doc: string, part?: string) => void;
  /** 为选中的判断补读孩子与两向引用（只进缓存）。 */
  ensureNeighborhood: (id: NodeId) => unknown;
  onFocusView: (id: NodeId) => void;
  /** 打开（或关闭）书写区；initial 是首次打开时的初值（草稿优先）。 */
  onOpenWriter: (id: NodeId, type: WriterType, initial?: Record<string, string>) => void;
  onCloseWriter: () => void;
  onWriterValues: (values: Record<string, string>) => void;
  /** 提交人的一次写入；成功时 App 会关闭书写区并清掉草稿。 */
  onSubmit: (nodeId: NodeId, write: HumanWrite) => Promise<WriteOutcome>;
  /** 视野边界：budget 用游标续读，scope 发起新读取。 */
  onExpand: (id: NodeId, axis: 'children' | 'refs', kind: Boundary['kind']) => void;
  /** 整棵树的时间线是否在阅读栏展开。 */
  timelineOpen: boolean;
  onCloseTimeline: () => void;
  /** Esc 收起展开项的计数器。 */
  collapseSignal: number;
  /** 阅读栏是否有展开项（决定 Esc 先收起还是取消选中）。 */
  onExpandedChange: (has: boolean) => void;
  /**
   * 归档当前判断的入口；缺省表示环境没有归档能力，阅读栏不显示任何归档控件。
   * onArchive 由 App 在服务端确认后移动选中并重读；本组件只负责确认与显示失败。
   */
  archiveAction?: {
    /** 当前判断的归档请求是否在路上。 */
    busy: boolean;
    /** 上一次归档失败（成功后由 App 清掉）；显示在动作下方。 */
    error: UiError | null;
    /** 发起归档；根判断即整棵树。 */
    onArchive: () => void;
  };
}

/**
 * 阅读栏。
 * @param p 见 ReaderProps
 */
export function Reader(p: ReaderProps) {
  const readerElement = useRef<HTMLElement>(null);
  const id = p.selectedId ?? p.rootId;
  const read = useNodeDetail(p.client, p.treeId, id, p.stamp);
  const node = read.detail?.node ?? null;
  const oldId = node?.origin.kind === 'replacement' ? node.origin.replacesId : null;
  const oldRead = useNodeDetail(p.client, p.treeId, oldId, p.stamp);
  const history = useHistory(p.client, p.treeId, id, p.stamp, 50);

  const [stateOpen, setStateOpen] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pruneOpen, setPruneOpen] = useState<Set<NodeId>>(() => new Set());
  const [warn, setWarn] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [errorAt, setErrorAt] = useState<'writer' | 'confirm'>('writer');
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const warnTimer = useRef(0);

  const writer = p.writer && p.writer.id === id ? p.writer : null;
  const isRoot = id === p.rootId;

  // 打开书写区时先收起状态词的去向；Esc 收回后元信息回到可点状态。
  useEffect(() => {
    if (writer) setStateOpen(false);
  }, [writer]);

  // 换一个决定时清掉上一次的失败说明；改写同一决定的内容时保留它。
  useEffect(() => {
    setError(null);
  }, [writer?.id, writer?.type]);

  // 选中变化：收起所有临时展开项。
  useEffect(() => {
    setStateOpen(false);
    setBodyOpen(false);
    setWhyOpen(false);
    setRefsOpen(false);
    setHistoryOpen(false);
    setPruneOpen(new Set());
    setError(null);
    setWarn(false);
    setArchiveConfirm(false);
  }, [id]);

  // Esc 由近及远：App 在收起展开项这一层递增计数。
  const lastCollapse = useRef(p.collapseSignal);
  useEffect(() => {
    if (lastCollapse.current === p.collapseSignal) return;
    lastCollapse.current = p.collapseSignal;
    setStateOpen(false);
    setBodyOpen(false);
    setWhyOpen(false);
    setRefsOpen(false);
    setHistoryOpen(false);
    setPruneOpen(new Set());
  }, [p.collapseSignal]);

  const expanded = stateOpen || bodyOpen || whyOpen || refsOpen || historyOpen || pruneOpen.size > 0;
  useEffect(() => {
    p.onExpandedChange(expanded);
  }, [expanded, p.onExpandedChange]);

  // 选中或版本变化时补读一层邻居；读到的行进缓存，不改视野。
  useEffect(() => {
    void p.ensureNeighborhood(id);
  }, [id, p.stamp, p.ensureNeighborhood]);

  /**
   * 记下：先校验必填，再提交；成功由 App 关闭书写区，失败在原地留下原因。
   * @param write 已组装的写入意图
   */
  const submit = async (write: HumanWrite) => {
    if (p.pending) return;
    setError(null);
    const r = await p.onSubmit(id, write);
    if (!r.ok) {
      setError(r.error);
      setErrorAt(writer ? 'writer' : 'confirm');
    }
  };

  const flashWarn = () => {
    window.clearTimeout(warnTimer.current);
    setWarn(true);
    warnTimer.current = window.setTimeout(() => setWarn(false), 720);
  };

  /** 校验书写区必填项并提交；缺项时只让提示短暂变赭石色，不提交。 */
  const submitWriter = () => {
    if (!writer || p.pending) return;
    if (missingWriterFields(writer.type, writer.values).length) {
      flashWarn();
      return;
    }
    void submit(writeFromWriter(writer.type, writer.values, writer.id));
  };

  // 书写区的键盘：Esc 收回、Ctrl/⌘ ↵ 记下。用捕获阶段，保证先于全局快捷键。
  useEffect(() => {
    if (!writer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // 记下中不收回：请求已在路上，输入框只读。
        if (!p.pending) p.onCloseWriter();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        submitWriter();
      }
    };
    return listenForKeys(readerElement.current, onKey, true);
    // submitWriter 读的是本次渲染的 writer / values，依赖它们即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writer, p.pending]);

  if (p.timelineOpen) {
    return (
      <aside ref={readerElement} className="ct-reader" aria-label="整棵树的时间线">
        <div className="ct-reader__scroll ct-scroll">
          <div className="ct-reader__bar">
            <span className="ct-reader__bar-title">整棵树的时间线</span>
            <button type="button" className="ct-textbtn" onClick={p.onCloseTimeline}>
              回到判断
            </button>
          </div>
          <Timeline
            client={p.client}
            treeId={p.treeId}
            stamp={p.stamp}
            known={p.known}
            onSelect={(nid) => p.onSelect(nid)}
            onHighlight={p.onHighlight}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside ref={readerElement} className="ct-reader" aria-label={p.selectedId ? '判断阅读栏' : '根问题阅读栏'}>
      <div className="ct-reader__scroll ct-scroll">
        {p.canBack && p.previousId && p.selectedId && (
          <div className="ct-reader__backline">
            <button type="button" className="ct-textbtn" onClick={p.onBack}>
              ‹ 回到 {p.previousId}
            </button>
          </div>
        )}
        {p.selectedId && !p.inView && (
          <div className="ct-reader__outview">
            不在当前视野 ·{' '}
            <button type="button" className="ct-link" onClick={() => p.onFocusView(p.selectedId!)}>
              以它为焦点
            </button>
          </div>
        )}

        {read.error && <div className="ct-banner ct-banner--danger">读取 {id} 失败：{read.error.message}</div>}
        {!read.detail && !read.error && <div className="ct-reader__loading">读取中…</div>}
        {node && read.detail && (
          <NodePage
            p={p}
            node={node}
            detail={read.detail}
            oldNode={oldRead.detail?.node ?? null}
            writer={writer}
            pending={p.pending}
            warn={warn}
            stateOpen={stateOpen}
            setStateOpen={setStateOpen}
            bodyOpen={bodyOpen}
            setBodyOpen={setBodyOpen}
            whyOpen={whyOpen}
            setWhyOpen={setWhyOpen}
            refsOpen={refsOpen}
            setRefsOpen={setRefsOpen}
            historyOpen={historyOpen}
            setHistoryOpen={setHistoryOpen}
            pruneOpen={pruneOpen}
            setPruneOpen={setPruneOpen}
            error={error}
            errorAt={errorAt}
            submit={submit}
            submitWriter={submitWriter}
            isRoot={isRoot}
            archiveConfirm={archiveConfirm}
            setArchiveConfirm={setArchiveConfirm}
            historyCount={history.items.length}
            historyHasMore={history.hasMore}
            onOpenWriter={p.onOpenWriter}
            onCloseWriter={p.onCloseWriter}
            onWriterValues={p.onWriterValues}
            known={p.known}
            refs={p.refs}
            onSelect={p.onSelect}
            onHighlight={p.onHighlight}
            onOpenSource={p.onOpenSource}
            onExpand={p.onExpand}
            onFocusView={p.onFocusView}
          />
        )}
      </div>
    </aside>
  );
}

interface NodePageProps {
  p: ReaderProps;
  node: CognitionNode;
  /** readNode 的结果：确认预览与目标绑定用它，不用异步分页或“最新节点”。 */
  detail: NodeDetail;
  oldNode: CognitionNode | null;
  writer: WriterState | null;
  pending: string | null;
  warn: boolean;
  stateOpen: boolean;
  setStateOpen: (v: boolean) => void;
  bodyOpen: boolean;
  setBodyOpen: (v: boolean) => void;
  whyOpen: boolean;
  setWhyOpen: (v: boolean) => void;
  refsOpen: boolean;
  setRefsOpen: (v: boolean) => void;
  historyOpen: boolean;
  setHistoryOpen: (v: boolean) => void;
  pruneOpen: Set<NodeId>;
  setPruneOpen: (v: Set<NodeId>) => void;
  error: UiError | null;
  errorAt: 'writer' | 'confirm';
  submit: (write: HumanWrite) => Promise<void>;
  submitWriter: () => void;
  isRoot: boolean;
  archiveConfirm: boolean;
  setArchiveConfirm: (open: boolean) => void;
  historyCount: number;
  historyHasMore: boolean;
  onOpenWriter: (id: NodeId, type: WriterType, initial?: Record<string, string>) => void;
  onCloseWriter: () => void;
  onWriterValues: (values: Record<string, string>) => void;
  known: Map<NodeId, ViewNode>;
  refs: Map<RefId, Ref>;
  onSelect: (id: NodeId) => void;
  onHighlight: (ids: NodeId[]) => void;
  onOpenSource: (doc: string, part?: string) => void;
  onExpand: (id: NodeId, axis: 'children' | 'refs', kind: Boundary['kind']) => void;
  onFocusView: (id: NodeId) => void;
}

/** 书写区的“当前 → 目标（未记下）”。 */
type WritingTarget =
  | { kind: 'state'; target: 'keep' | 'open' | 'prune' }
  | { kind: 'replacement' }
  | { kind: 'branch'; label: string };

/**
 * 一个判断的一页（包括根问题页）。
 * @param props 见 NodePageProps
 */
function NodePage(props: NodePageProps) {
  const { node: n, p, writer } = props;
  const id = n.id;
  const isRoot = props.isRoot;
  const writing = !!writer;
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setConfirmOpen(false);
  }, [id]);
  useEffect(() => {
    if (writing) setConfirmOpen(false);
  }, [writing]);

  const children = useMemo(
    () => [...p.known.values()].filter((c) => c.parentId === id).sort((a, b) => compareIds(a.id, b.id)),
    [p.known, id],
  );
  // 待确认指的是当前变更是 AI 执行且未经人确认；确认程度与执行者分开读，不看旧原型字段。
  const pendingKids = children.filter(isAiProposed);
  const settledKids = children.filter((c) => !isAiProposed(c));
  const prunedKids = settledKids.filter((c) => c.state === 'prune');
  const keptKids = settledKids.filter((c) => c.state === 'keep');
  const openKids = settledKids.filter((c) => c.state === 'open');
  const unknownKids = settledKids.filter((c) => c.state === undefined);
  const incomingReplacements = useMemo(
    () =>
      [...p.known.values()].filter(
        (c) => c.origin.kind === 'replacement' && c.origin.replacesId === id && c.state !== 'prune' && isAiProposed(c),
      ),
    [p.known, id],
  );
  const outRefs = useMemo(() => [...p.refs.values()].filter((r) => r.from === id), [p.refs, id]);
  const inRefs = useMemo(
    () => [...p.refs.values()].filter((r) => r.target.nodeId !== undefined && r.target.nodeId === id),
    [p.refs, id],
  );
  const replacedBy = useMemo(
    () => [...p.known.values()].find((c) => c.origin.kind === 'replacement' && c.origin.replacesId === id && c.origin.status === 'applied'),
    [p.known, id],
  );
  /** 确认目标：有当前变更时绑定那条形成记录，没有日常变更的导入判断才用节点 ID。 */
  const confirmTarget = confirmTargetOf(props.detail);
  /** 待执行的替代候选不能切换留 / 未决；剪除仍可用。 */
  const canSwitch = !(n.origin.kind === 'replacement' && n.origin.status === 'proposed' && n.state !== 'prune');
  const boundary = p.boundaries.find((b) => b.nodeId === id);

  const why = n.body.basis || n.body.source || n.body.note;
  // 正文只取手稿的“内容”；依据、来源、说明属于三问里的“为什么”，避免同一段话出现两次。
  const bodyText = n.body.text;
  const bodyLong = !!bodyText && Array.from(bodyText).length > 70;
  const canHaveBody = !!bodyText;

  const writingTarget: WritingTarget | null =
    writer?.type === 'prune'
      ? { kind: 'state', target: 'prune' }
      : writer?.type === 'revive' || writer?.type === 'switch'
        ? { kind: 'state', target: writer.values.state === 'open' ? 'open' : 'keep' }
        : writer?.type === 'accept'
          ? { kind: 'replacement' }
          : writer && isBranchWriter(writer.type)
            ? { kind: 'branch', label: BRANCH_WRITER_LABEL[writer.type] }
            : null;

  /** 打开新增子判断 / 补充 / 勘误的书写区；缺省状态为留。 */
  const openAdd = (relation: 'branch' | 'supplement' | 'erratum') =>
    props.onOpenWriter(id, relation, { state: 'keep' });
  /** 状态词选“剪”：两项理由都必填。 */
  const openPrune = () => props.onOpenWriter(id, 'prune');
  /** 状态词选“留 / 未决”：已剪是重新启用，写条件变化。 */
  const openRevive = (state: 'keep' | 'open') => props.onOpenWriter(id, 'revive', { state });
  /** 未剪时切换留 / 未决（含状态未载）：写理由。 */
  const openSwitch = (state: 'keep' | 'open') => props.onOpenWriter(id, 'switch', { state });
  /** 替代提议：比较原文后执行替代。 */
  const openAccept = () => props.onOpenWriter(id, 'accept');

  const togglePrune = (child: NodeId) => {
    const s = new Set(props.pruneOpen);
    if (s.has(child)) s.delete(child);
    else s.add(child);
    props.setPruneOpen(s);
  };

  return (
    <>
      <div className="ct-reader__meta">
        <CopyId id={id} />
        <span className="ct-reader__dot">·</span>
        {writingTarget ? (
          <span className="ct-readmeta">
            {writingTarget.kind === 'branch' ? (
              <span className="ct-readmeta__target">{writingTarget.label}（未记下）</span>
            ) : writingTarget.kind === 'replacement' ? (
              <>
                <span className="ct-readmeta__now">{confirmationLabel(confirmationView(n))}</span>
                <span className="ct-readmeta__arrow">→</span>
                <span className="ct-readmeta__target">已执行替代（未记下）</span>
              </>
            ) : (
              <>
                <span className="ct-readmeta__now">
                  <NodeGlyph state={n.state} confirmation={null} size={13} />
                  {stateLabel(n.state)}
                </span>
                <span className="ct-readmeta__arrow">→</span>
                <span className="ct-readmeta__target">
                  <NodeGlyph state={writingTarget.target} confirmation={null} size={13} />
                  {stateLabel(writingTarget.target)}（未记下）
                </span>
              </>
            )}
          </span>
        ) : (
          <>
            <StateControl
              node={n}
              isRoot={isRoot}
              open={props.stateOpen}
              pending={writing}
              canSwitch={canSwitch}
              onToggle={() => props.setStateOpen(!props.stateOpen)}
              onPrune={openPrune}
              onRevive={openRevive}
              onSwitch={openSwitch}
            />
            <span className="ct-reader__dot">·</span>
            <ConfirmControl
              node={n}
              detail={props.detail}
              pending={props.pending === id + ':confirm'}
              open={confirmOpen}
              onToggle={() => setConfirmOpen((v) => !v)}
              onAccept={openAccept}
              disabled={writing}
            />
          </>
        )}
        <OriginText origin={n.origin} onSelect={p.onSelect} />
      </div>

      {confirmOpen && confirmTarget && (
        <ConfirmPreview
          detail={props.detail}
          target={confirmTarget}
          pending={props.pending === id + ':confirm'}
          onClose={() => setConfirmOpen(false)}
          onConfirm={(target: ConfirmTarget) => void props.submit({ kind: 'confirm', target })}
        />
      )}

      {props.errorAt === 'confirm' && props.error && !writer && (
        <div className="ct-reader__inlineerror" role="alert">
          没有记下：{props.error.message}
        </div>
      )}

      <h1 className="ct-reader__title">{n.body.title}</h1>

      {canHaveBody && (
        <div
          className={'ct-reader__body' + (props.bodyOpen ? ' is-open' : '') + (bodyLong ? ' is-clamped' : '')}
          onClick={() => bodyLong && props.setBodyOpen(!props.bodyOpen)}
          role={bodyLong ? 'button' : undefined}
          tabIndex={bodyLong ? 0 : undefined}
          onKeyDown={(e) => {
            if (bodyLong && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              props.setBodyOpen(!props.bodyOpen);
            }
          }}
        >
          <RichText text={bodyText!} onOpenSource={p.onOpenSource} />
        </div>
      )}

      {!writing && (
        <div className="ct-reader__erratum">
          <button type="button" className="ct-textbtn" onClick={() => openAdd('branch')}>
            新增子判断…
          </button>
          <span className="ct-reader__dot">·</span>
          <button type="button" className="ct-textbtn" onClick={() => openAdd('supplement')}>
            补充…
          </button>
          <span className="ct-reader__dot">·</span>
          <button type="button" className="ct-textbtn" onClick={() => openAdd('erratum')}>
            写一句勘误…
          </button>
          {props.p.archiveAction && (
            <>
              <span className="ct-reader__dot">·</span>
              <button
                type="button"
                className="ct-textbtn"
                disabled={props.p.archiveAction.busy}
                onClick={() => props.setArchiveConfirm(true)}
                title={
                  isRoot
                    ? '归档整棵树：从全部树列表移到已归档，可在目录里恢复'
                    : '归档这个判断及其整个子树；可在「已归档」里恢复'
                }
              >
                {isRoot ? ARCHIVE_COPY.archiveRoot : ARCHIVE_COPY.archiveNode}
              </button>
            </>
          )}
        </div>
      )}

      {props.archiveConfirm && props.p.archiveAction && !writing && (
        <div className="ct-reader__archiveconfirm" role="alert">
          <span className="ct-reader__archivecopy">
            {isRoot ? ARCHIVE_COPY.confirmRoot : ARCHIVE_COPY.confirmNode}
          </span>
          <Button
            size="sm"
            variant="danger"
            loading={props.p.archiveAction.busy}
            onClick={() => {
              props.setArchiveConfirm(false);
              props.p.archiveAction?.onArchive();
            }}
          >
            {ARCHIVE_COPY.confirmAction}
          </Button>
          <button
            type="button"
            className="ct-textbtn"
            disabled={props.p.archiveAction.busy}
            onClick={() => props.setArchiveConfirm(false)}
          >
            {ARCHIVE_COPY.cancel}
          </button>
        </div>
      )}

      {props.p.archiveAction?.error && !writing && (
        <div className="ct-reader__inlineerror" role="alert">
          {ARCHIVE_COPY.archiveFailed}
          {props.p.archiveAction.error.message}
        </div>
      )}

      {writer && (
        <div className="ct-writer">
          <div className="ct-writer__line">
            {writer.type === 'revive' && (
              <div className="ct-writer__prev">
                <div className="ct-writer__prev-label">此前</div>
                <p>
                  <span className="ct-writer__prev-key">剪除理由</span>
                  {n.pruneReason ?? <span className="ct-faint">未记录</span>}
                </p>
                <p>
                  <span className="ct-writer__prev-key">复活条件</span>
                  {n.reviveWhen ?? <span className="ct-writer__prev-key is-missing">缺项 · 未记录复活条件</span>}
                </p>
              </div>
            )}
            {writer.type === 'accept' && (
              <div className="ct-writer__compare">
                <div className="ct-writer__prev-label">被替代的判断 · {n.origin.kind === 'replacement' ? n.origin.replacesId : ''}</div>
                <div className="ct-writer__compare-title">{props.oldNode?.body.title ?? p.known.get(n.origin.kind === 'replacement' ? n.origin.replacesId : '')?.title ?? '（未读入）'}</div>
                {(props.oldNode?.body.text || props.oldNode?.body.basis) && (
                  <div className="ct-writer__compare-body">
                    <RichText text={(props.oldNode.body.text ?? props.oldNode.body.basis)!} onOpenSource={p.onOpenSource} />
                  </div>
                )}
              </div>
            )}
            {(writer.type === 'revive' || writer.type === 'switch' || isBranchWriter(writer.type)) && (
              <div className="ct-writer__choice">
                <span>{writer.type === 'revive' ? '恢复为' : '分支状态'}</span>
                <button
                  type="button"
                  className={'ct-textbtn' + ((writer.values.state ?? 'keep') === 'keep' ? ' is-on' : '')}
                  onClick={() => props.onWriterValues({ ...writer.values, state: 'keep' })}
                >
                  留
                </button>
                <button
                  type="button"
                  className={'ct-textbtn' + (writer.values.state === 'open' ? ' is-on' : '')}
                  onClick={() => props.onWriterValues({ ...writer.values, state: 'open' })}
                >
                  未决
                </button>
              </div>
            )}

            {WRITER_CONFIG[writer.type].questions.map((q) => (
              <WriterField
                key={q.key}
                question={q.question + (q.required ? '（必填）' : '')}
                value={writer.values[q.key] ?? ''}
                readOnly={!!props.pending}
                onChange={(v) => props.onWriterValues({ ...writer.values, [q.key]: v })}
              />
            ))}

            <div className={'ct-writer__hint' + (props.warn ? ' is-warn' : '')}>
              Ctrl ↵ 记下 · Esc 收回 · {WRITER_CONFIG[writer.type].hint}
              {props.pending && <span className="ct-writer__saving">记下中…</span>}
            </div>
          </div>
          {props.errorAt === 'writer' && props.error && (
            <div className="ct-writer__error" role="alert">
              没有记下：{props.error.message}
            </div>
          )}
        </div>
      )}

      <div className="ct-reader__sections">
        {n.state === 'prune' && (
          <Section title="为什么剪去">
            <p className="ct-reader__reason">
              {n.pruneReason ? <RichText text={n.pruneReason} onOpenSource={p.onOpenSource} /> : <span className="ct-faint">缺项 · 未记录剪除理由</span>}
            </p>
            {n.reviveWhen ? (
              <p className="ct-reader__sub">
                <span className="ct-reader__sub-key">重新考虑的条件</span>
                {n.reviveWhen}
              </p>
            ) : (
              <p className="ct-reader__sub ct-reader__missing">缺项 · 未记录复活条件</p>
            )}
            {replacedBy && (
              <p className="ct-reader__sub">
                由 <NodeChip id={replacedBy.id} onClick={p.onSelect} /> 替代
              </p>
            )}
          </Section>
        )}

        {why && (
          <Section title="为什么">
            <div
              className="ct-reader__row"
              role="button"
              tabIndex={0}
              aria-expanded={props.whyOpen}
              onClick={() => props.setWhyOpen(!props.whyOpen)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  props.setWhyOpen(!props.whyOpen);
                }
              }}
            >
              <span className="ct-reader__row-main">
                <RichText text={why} onOpenSource={p.onOpenSource} />
              </span>
              <span className={'ct-reader__chev' + (props.whyOpen ? ' is-open' : '')}>›</span>
            </div>
            <Reveal open={props.whyOpen}>
              <div className="ct-reader__detail">
                {n.body.basis && (
                  <p>
                    <span className="ct-reader__detail-key">依据</span>
                    <RichText text={n.body.basis} onOpenSource={p.onOpenSource} />
                  </p>
                )}
                {n.body.source && (
                  <p>
                    <span className="ct-reader__detail-key">来源</span>
                    <RichText text={n.body.source} onOpenSource={p.onOpenSource} />
                  </p>
                )}
                {n.body.note && (
                  <p>
                    <span className="ct-reader__detail-key">确认说明</span>
                    <RichText text={n.body.note} onOpenSource={p.onOpenSource} />
                  </p>
                )}
              </div>
            </Reveal>
          </Section>
        )}

        {prunedKids.length > 0 && (
          <Section title="排除了什么">
            {prunedKids.map((c) => (
              <PrunedChildRow
                key={c.id}
                child={c}
                open={props.pruneOpen.has(c.id)}
                onToggle={() => togglePrune(c.id)}
                client={p.client}
                treeId={p.treeId}
                stamp={p.stamp}
                onSelect={p.onSelect}
                onOpenSource={p.onOpenSource}
              />
            ))}
          </Section>
        )}

        {keptKids.length > 0 && (
          <Section title="留下的">
            {keptKids.map((c) => (
              <button key={c.id} type="button" className="ct-reader__row" onClick={() => p.onSelect(c.id)}>
                <span className="ct-reader__row-mark">
                  <NodeGlyph state={c.state} confirmation={confirmationView(c)} size={12} />
                  <OriginMark origin={c.origin} />
                </span>
                <span className="ct-reader__row-main">{c.title}</span>
                <span className="ct-reader__chev">›</span>
              </button>
            ))}
          </Section>
        )}

        <Section title="还没定">
          {n.body.openReason && <p className="ct-reader__openreason">{n.body.openReason}</p>}
          {openKids.map((c) => (
            <button key={c.id} type="button" className="ct-reader__row" onClick={() => p.onSelect(c.id)}>
              <span className="ct-reader__row-mark">{originMark(c.origin)}</span>
              <span className="ct-reader__row-main">{c.title}</span>
              <span className="ct-reader__chev">›</span>
            </button>
          ))}
          {pendingKids.map((c) => (
            <button key={c.id} type="button" className="ct-reader__row is-pending" onClick={() => p.onSelect(c.id)}>
              <span className="ct-reader__row-mark">
                <NodeGlyph state={c.state} confirmation={confirmationView(c)} size={12} />
              </span>
              <span className="ct-reader__row-main">{c.title}</span>
              <span className="ct-reader__row-tag">待确认</span>
            </button>
          ))}
          {incomingReplacements.map((c) => (
            <button key={c.id} type="button" className="ct-reader__row is-pending" onClick={() => p.onSelect(c.id)}>
              <span className="ct-reader__row-mark">替</span>
              <span className="ct-reader__row-main">有替代提议：{c.title}</span>
              <span className="ct-reader__row-tag">待确认</span>
            </button>
          ))}
          {!n.body.openReason && !boundary && openKids.length + pendingKids.length + incomingReplacements.length === 0 && (
            <p className="ct-reader__sub ct-faint">范围内已读完、没有未决</p>
          )}
          {boundary && (
            <p className="ct-reader__sub">
              这一支还没读完 ·{' '}
              <button type="button" className="ct-link" onClick={() => props.onExpand(id, boundary.axis, boundary.kind)}>
                续读
              </button>
            </p>
          )}
        </Section>

        {unknownKids.length > 0 && (
          <Section title="状态未载">
            {unknownKids.map((c) => (
              <button key={c.id} type="button" className="ct-reader__row" onClick={() => p.onSelect(c.id)}>
                <span className="ct-reader__row-mark">
                  <NodeGlyph state={null} confirmation={confirmationView(c)} size={12} />
                </span>
                <span className="ct-reader__row-main">{c.title}</span>
                <span className="ct-reader__chev">›</span>
              </button>
            ))}
          </Section>
        )}
      </div>

      <div className="ct-reader__footer">
        {!p.selectedId ? (
          <p className="ct-reader__shortcuts">
            Ctrl K 查找 · F 看全 · B 回到上一个 · 1 / 2 / 3 阅读方式 · Ctrl ↵ 记下 · Esc 由近及远收回
          </p>
        ) : (
          <>
            {outRefs.length + inRefs.length > 0 && (
              <button type="button" className="ct-reader__footlink" onClick={() => props.setRefsOpen(!props.refsOpen)}>
                引用 · 出 {outRefs.length} · 入 {inRefs.length} <span className={props.refsOpen ? 'is-open' : ''}>›</span>
              </button>
            )}
            <button type="button" className="ct-reader__footlink" onClick={() => props.setHistoryOpen(!props.historyOpen)}>
              这条判断的经过 · {props.historyCount}
              {props.historyHasMore ? '+' : ''} 条 <span className={props.historyOpen ? 'is-open' : ''}>›</span>
            </button>
          </>
        )}

        <Reveal open={props.refsOpen}>
          <div className="ct-reader__reflist">
            {outRefs.map((r) => (
              <RefRow key={r.id} r={r} dir="out" p={p} />
            ))}
            {inRefs.map((r) => (
              <RefRow key={r.id} r={r} dir="in" p={p} />
            ))}
          </div>
        </Reveal>

        <Reveal open={props.historyOpen}>
          <div className="ct-reader__history">
            <Timeline
              client={p.client}
              treeId={p.treeId}
              stamp={p.stamp}
              nodeId={id}
              known={p.known}
              compact
              onSelect={p.onSelect}
              onHighlight={p.onHighlight}
            />
          </div>
        </Reveal>
      </div>
    </>
  );
}

/**
 * 一条被剪的子判断：标题一行，点开后才读它的剪除理由与复活条件（缺项就明说）。
 */
function PrunedChildRow(props: {
  child: ViewNode;
  open: boolean;
  onToggle: () => void;
  client: CognitionClient;
  treeId: TreeId;
  stamp: number;
  onSelect: (id: NodeId) => void;
  onOpenSource: (doc: string, part?: string) => void;
}) {
  const { child, open } = props;
  const read = useNodeDetail(props.client, props.treeId, open ? child.id : null, props.stamp);
  const n = read.detail?.node;
  return (
    <div className="ct-reader__pruneitem">
      <button type="button" className="ct-reader__row is-prune" onClick={props.onToggle} aria-expanded={open}>
        <span className="ct-reader__row-mark">
          <NodeGlyph state={child.state} confirmation={confirmationView(child)} size={12} />
          <OriginMark origin={child.origin} />
        </span>
        <span className="ct-reader__row-main">{child.title}</span>
        <span className={'ct-reader__chev' + (open ? ' is-open' : '')}>›</span>
      </button>
      <Reveal open={open}>
        <div className="ct-reader__detail is-prunereason">
          {read.error && <p className="ct-reader__missing">读取失败：{read.error.message}</p>}
          {!n && !read.error && <p className="ct-faint">读取中…</p>}
          {n && (
            <>
              <p>
                <span className="ct-reader__detail-key">理由</span>
                {n.pruneReason ? <RichText text={n.pruneReason} onOpenSource={props.onOpenSource} /> : <span className="ct-reader__missing">缺项 · 未记录剪除理由</span>}
              </p>
              <p>
                <span className="ct-reader__detail-key">复活条件</span>
                {n.reviveWhen ? n.reviveWhen : <span className="ct-reader__missing">缺项 · 未记录复活条件</span>}
              </p>
            </>
          )}
          <button type="button" className="ct-textbtn ct-reader__open" onClick={() => props.onSelect(child.id)}>
            打开 {child.id} ›
          </button>
        </div>
      </Reveal>
    </div>
  );
}

/**
 * 书写区的一个字段：空着时问题就是占位语；开始书写后，问题缩成框上方的一行小字。
 */
function WriterField(props: { question: string; value: string; readOnly: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [props.value]);
  return (
    <div className="ct-writer__field">
      {props.value.trim() !== '' && <div className="ct-writer__q">{props.question}</div>}
      <textarea
        ref={ref}
        rows={1}
        className="ct-writer__input"
        value={props.value}
        readOnly={props.readOnly}
        placeholder={props.question}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * 展开/收起：高度与透明度 220ms（减少动态时立即）。
 * @param props.open 是否展开
 * @param props.children 内容
 */
function Reveal(props: { open: boolean; children: ReactNode }) {
  return (
    <div className={'ct-reveal' + (props.open ? ' is-open' : '')}>
      <div className="ct-reveal__inner">{props.children}</div>
    </div>
  );
}

/**
 * 一节三问：只有有内容时才由调用方渲染。
 * @param props.title 小标题
 * @param props.children 内容
 */
function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="ct-reader__section">
      <h3 className="ct-reader__section-title">{props.title}</h3>
      <div className="ct-reader__section-body">{props.children}</div>
    </section>
  );
}

/**
 * 一条引用：类型、方向、另一端（判断或外部材料）。
 * 树内目标省略 part 指整个判断；外部材料只显示定位符，不展开成另一棵树。
 * @param props.r 引用边
 * @param props.dir out 表示本判断是 from；in 表示本判断是目标
 * @param props.p 阅读栏属性
 */
function RefRow(props: { r: Ref; dir: 'out' | 'in'; p: Pick<ReaderProps, 'known' | 'onSelect' | 'onOpenSource'> }) {
  const { r, dir, p } = props;
  const t = r.target;
  const other = dir === 'in' ? r.from : t.nodeId !== undefined ? t.nodeId : null;
  return (
    <div className="ct-reader__refrow">
      <RefKindSample kind={r.kind} />
      <span className="ct-reader__refdir">{dir === 'out' ? '→' : '←'}</span>
      {other ? (
        <NodeChip id={other} title={p.known.get(other)?.title} onClick={p.onSelect} />
      ) : t.doc !== undefined ? (
        <button type="button" className="ct-source" onClick={() => p.onOpenSource(t.doc, t.part)}>
          {t.doc}
          {t.part ? ' · ' + t.part : ''}
        </button>
      ) : null}
      {dir === 'out' && t.nodeId !== undefined && partLabel(t.part) && (
        <span className="ct-reader__refpart">{partLabel(t.part)}</span>
      )}
    </div>
  );
}
