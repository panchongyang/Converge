/**
 * 空间：一棵可以细读的径向推导图。
 *
 * - 根问题在中央，判断按层向外生长；细线是真实父子关系，剪的树枝变成淡虚线并在近子节点处留断口。
 * - 选中时推导链与直接子枝加深，其余退淡；标签字号随窗口在 14–17px 之间变化、最多两行，超过 14 字截断，悬停显示全文与 ID。
 * - 标签互不交叠、也不压树枝；放不下时按“选中 > 推导链 > 浅层”保留，其余暂时隐藏，悬停仍可见。
 * - 引用弧只在悬停或选中时出现；外部材料的出处不在空间里画，统一在阅读栏的依据里打开。边界芽「+」表示参数范围到此，「⋯」表示预算先到。
 * - 布局按 UI 已读到的全部节点计算，位置由 ID 哈希抖动，刷新后不变；只移镜头，不挪节点。
 * 本模块只发出选择、悬停、续读、打开出处的意图，不调用端口。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import type { Boundary, NodeId, Ref, RefId, ViewNode } from '../../types/kernel';
import { useElementSize } from '../../hooks/useElementSize';
import { useTweenedPositions, type Pt } from '../../hooks/useTweenedPositions';
import type { RevealRequest } from '../../models/useSelection';
import {
  bezierAt,
  chainToRoot,
  layoutTree,
  refArc,
  treeEdgeControls,
  treeEdgePath,
  type LayoutMode,
  type Placed,
} from '../../utils/layout';
import {
  clip,
  confirmationLabel,
  confirmationView,
  isAiProposed,
  originMark,
  partLabel,
  REF_KIND,
  stateLabel,
  textWidth,
  type ConfirmationView,
} from '../../utils/labels';
import { useCamera, type Insets } from './useCamera';
import './space.css';

export interface CameraCommand {
  type: 'fit' | 'in' | 'out';
  seq: number;
}

export interface SpaceViewProps {
  rootId: NodeId;
  /** UI 已读到的全部节点：只用于计算稳定布局。 */
  known: Map<NodeId, ViewNode>;
  /** 当前视野里要画的节点。 */
  visible: Set<NodeId>;
  roles: Map<NodeId, 'hit' | 'link'>;
  refs: Map<RefId, Ref>;
  boundaries: Boundary[];
  selectedId: NodeId | null;
  hoveredId: NodeId | null;
  highlightIds: NodeId[];
  /** 本次会话新到的 AI 提议：只用于 400ms 淡入，不改变状态。 */
  arrivedIds: Set<NodeId>;
  /** 视野指纹：全景/聚焦或参数改变时重新取景；选中变化不影响。 */
  viewKey: string;
  /** 图的布局模式：径向 / 横向树 / 纵向树。 */
  layoutMode: LayoutMode;
  reveal: RevealRequest | null;
  camCommand: CameraCommand | null;
  reducedMotion: boolean;
  onSelect: (id: NodeId | null) => void;
  onHover: (id: NodeId | null) => void;
  onExpand: (id: NodeId, axis: 'children' | 'refs', kind: Boundary['kind']) => void;
}

/** 状态行占去的高度（px），镜头居中与看全时避让。 */
const STATUS_INSET: Insets = { left: 16, right: 16, top: 16, bottom: 44 };

interface ScreenPt {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LabelCandidate {
  id: NodeId;
  root: boolean;
  lines: string[];
  /** 屏幕坐标。 */
  left: number;
  top: number;
  width: number;
  /** 文字对齐，也决定标签在节点哪一侧。 */
  align: 'left' | 'right' | 'center';
  box: Rect;
}

interface EdgeSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * 空间视图。
 * @param p 见 SpaceViewProps
 */
export function SpaceView(p: SpaceViewProps) {
  const [stageRef, size] = useElementSize<HTMLDivElement>();
  const camApi = useCamera(stageRef, size, STATUS_INSET, p.reducedMotion);
  const cam = camApi.cam;
  const [dragging, setDragging] = useState(false);
  const [intro, setIntro] = useState(false);

  // 标签字号随窗口连续变化；避让计算要用 CSS clamp 之后的实际值，用两个隐藏探针读取。
  const labelProbe = useRef<HTMLSpanElement>(null);
  const rootProbe = useRef<HTMLSpanElement>(null);
  const [labelFont, setLabelFont] = useState(14);
  const [rootFont, setRootFont] = useState(19.6);
  useLayoutEffect(() => {
    const labelEl = labelProbe.current;
    const rootEl = rootProbe.current;
    if (!labelEl || !rootEl) return;
    const nextLabel = parseFloat(getComputedStyle(labelEl).fontSize) || 14;
    const nextRoot = parseFloat(getComputedStyle(rootEl).fontSize) || 19.6;
    setLabelFont((prev) => (Math.abs(prev - nextLabel) > 0.05 ? nextLabel : prev));
    setRootFont((prev) => (Math.abs(prev - nextRoot) > 0.05 ? nextRoot : prev));
  }, [size.width]);

  // —— 布局：在全部已知节点上算，保证位置稳定；只画可见节点 ——
  const layout = useMemo(() => layoutTree(p.layoutMode, [...p.known.values()], p.rootId), [p.known, p.rootId, p.layoutMode]);
  const target = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const id of p.visible) {
      const pos = layout.pos.get(id);
      if (pos) m.set(id, pos);
    }
    return m;
  }, [layout, p.visible]);
  const knownRef = useRef(p.known);
  knownRef.current = p.known;
  const spawnFrom = makeSpawnFrom(knownRef);
  const pos = useTweenedPositions(target, spawnFrom, 420, p.reducedMotion);

  const visBounds = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of target.values()) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
    return minX === Infinity ? layout.bounds : { minX, minY, maxX, maxY };
  }, [target, layout]);

  // —— 首次取景与“看全” ——
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || size.width === 0 || target.size === 0) return;
    fittedRef.current = true;
    camApi.fit(padBounds(visBounds, 84));
  }, [size.width, target.size, visBounds, camApi]);

  // 窗口或阅读方式改变导致舞台尺寸变化时重新取景（选中变化不触发）。
  const lastSize = useRef({ width: 0, height: 0 });
  useEffect(() => {
    if (!fittedRef.current || size.width === 0) return;
    const last = lastSize.current;
    if (last.width === 0) {
      lastSize.current = size;
      return;
    }
    if (Math.abs(last.width - size.width) < 2 && Math.abs(last.height - size.height) < 2) return;
    lastSize.current = size;
    if (target.size > 0) camApi.fit(padBounds(visBounds, 84));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  // 视野参数改变时重新取景；选中别的判断只平移镜头。
  const lastLayoutMode = useRef(p.layoutMode);
  useEffect(() => {
    if (lastLayoutMode.current === p.layoutMode) return;
    lastLayoutMode.current = p.layoutMode;
    if (target.size > 0) camApi.fit(padBounds(visBounds, 84));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.layoutMode]);

  const lastViewKey = useRef(p.viewKey);
  useEffect(() => {
    if (lastViewKey.current === p.viewKey) return;
    lastViewKey.current = p.viewKey;
    if (target.size > 0) camApi.fit(padBounds(visBounds, 84));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.viewKey]);

  // —— 外部跳转：目标连同标签已在可视区内就不动镜头，出界时才最小平移 ——
  const posRef = useRef(pos);
  posRef.current = pos;
  useEffect(() => {
    if (!p.reveal) return;
    const stage = stageRef.current;
    if (!stage || size.width === 0) return;
    const id = p.reveal.id;
    const placed = posRef.current.get(id) ?? layout.pos.get(id);
    const node = knownRef.current.get(id);
    if (!placed || !node) return;
    const c = camApi.camRef.current;
    const sx = placed.x * c.k + c.x;
    const sy = placed.y * c.k + c.y;
    const radius = id === p.rootId ? 20 : 17;
    let box: ScreenBox = { left: sx - radius, top: sy - radius, right: sx + radius, bottom: sy + radius };

    const labelEl = stage.querySelector<HTMLElement>('.ct-slabel[data-id="' + id + '"]');
    if (labelEl) {
      const sr = stage.getBoundingClientRect();
      const r = labelEl.getBoundingClientRect();
      box = unionBox(box, { left: r.left - sr.left, top: r.top - sr.top, right: r.right - sr.left, bottom: r.bottom - sr.top });
    } else {
      // 标签被暂时隐藏或已在舞台外：按首选方位估一个盒子，避免只把节点拉进来而把标签留在外面。
      box = unionBox(box, approxLabelBox(node.title, placed.angle, sx, sy, id === p.rootId, labelFont, rootFont));
    }

    const { dx, dy } = panCorrection(box, size.width, size.height, 48);
    if (dx !== 0 || dy !== 0) camApi.moveTo(c.x + dx, c.y + dy, 420);
    // 只响应新的请求序号
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.reveal?.seq]);
  useEffect(() => {
    if (!p.camCommand) return;
    if (p.camCommand.type === 'fit') camApi.fit(padBounds(visBounds, 84));
    else camApi.zoomBy(p.camCommand.type === 'in' ? 1.2 : 1 / 1.2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.camCommand?.seq]);

  // —— 开场：树枝按层由根向外画出、标签随后淡入；只播一次，总长不超过 800ms ——
  const introPlayed = useRef(false);
  useEffect(() => {
    if (introPlayed.current || p.reducedMotion || pos.size === 0) return;
    introPlayed.current = true;
    setIntro(true);
    const t = window.setTimeout(() => setIntro(false), 820);
    return () => window.clearTimeout(t);
  }, [pos.size, p.reducedMotion]);

  // —— 选中：推导链、直接子枝与引用邻居 ——
  const chain = useMemo(
    () => (p.selectedId ? chainToRoot(p.selectedId, (id) => p.known.get(id)?.parentId) : []),
    [p.selectedId, p.known],
  );
  const chainSet = useMemo(() => new Set(chain), [chain]);
  const highlightSet = useMemo(() => new Set(p.highlightIds), [p.highlightIds]);
  const focusSet = useMemo(() => {
    if (!p.selectedId) return null;
    const s = new Set<NodeId>(chain);
    for (const n of p.known.values()) if (n.parentId === p.selectedId) s.add(n.id);
    if (p.hoveredId) s.add(p.hoveredId);
    for (const id of p.highlightIds) s.add(id);
    return s;
  }, [chain, p.selectedId, p.hoveredId, p.known, p.highlightIds]);

  // —— 拖拽平移、空白处取消选中、滚轮缩放由 useCamera 处理 ——
  const drag = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    camApi.stop();
    drag.current = { px: e.clientX, py: e.clientY, x: camApi.camRef.current.x, y: camApi.camRef.current.y, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) setDragging(true);
    d.moved = true;
    camApi.set({ x: d.x + dx, y: d.y + dy, k: camApi.camRef.current.k });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d && !d.moved) p.onSelect(null);
  };

  const k = cam.k;
  const nodes = [...pos.entries()]
    .map(([id, pt]) => ({ id, pt, n: p.known.get(id) }))
    .filter((x): x is { id: string; pt: Placed; n: ViewNode } => !!x.n);

  const screen = new Map<NodeId, ScreenPt>();
  for (const { id, pt } of nodes) screen.set(id, { x: pt.x * k + cam.x, y: pt.y * k + cam.y });

  // —— 标签：先算候选框，再按优先级避让 ——
  const labels = placeLabels({
    nodes,
    screen,
    rootId: p.rootId,
    selectedId: p.selectedId,
    chainSet,
    k,
    cam,
    stage: size,
    labelFont,
    rootFont,
    layoutMode: p.layoutMode,
  });

  // —— 悬停提示：全文、ID 与状态 ——
  const hoveredNode = p.hoveredId ? p.known.get(p.hoveredId) : undefined;
  const hoveredPt = p.hoveredId ? screen.get(p.hoveredId) : undefined;
  const tip =
    hoveredNode && hoveredPt && !dragging
      ? {
          left: Math.max(8, Math.min(size.width - 236, hoveredPt.x + 24)),
          top: Math.max(8, Math.min(size.height - 92, hoveredPt.y - 14)),
          node: hoveredNode,
        }
      : null;

  const activeId = p.hoveredId ?? p.selectedId;
  const activeRefs = useMemo(() => {
    if (!activeId) return [];
    return [...p.refs.values()].filter((r) => {
      if (r.from !== activeId && !(r.target.nodeId !== undefined && r.target.nodeId === activeId)) return false;
      if (!screen.has(r.from)) return false;
      if (r.target.nodeId !== undefined && !screen.has(r.target.nodeId)) return false;
      return true;
    });
  }, [activeId, p.refs, screen]);

  const buds = useMemo(() => {
    const m = new Map<NodeId, Boundary[]>();
    for (const b of p.boundaries) {
      if (!pos.has(b.nodeId)) continue;
      const list = m.get(b.nodeId) ?? [];
      list.push(b);
      m.set(b.nodeId, list);
    }
    return m;
  }, [p.boundaries, pos]);

  const cutFor = (parent: Placed, child: Placed): Pt | null => {
    const ctrl = treeEdgeControls(p.layoutMode, parent, child);
    const c = bezierAt(ctrl, 0.9);
    return { x: c.x, y: c.y };
  };

  return (
    <div ref={stageRef} className={'ct-space' + (dragging ? ' is-dragging' : '') + (p.reducedMotion ? ' is-still' : '')}>
      <span ref={labelProbe} className="ct-slabel-probe" aria-hidden="true" />
      <span ref={rootProbe} className="ct-slabel-probe ct-slabel-probe--root" aria-hidden="true" />
      <svg
        className="ct-space__svg"
        role="application"
        aria-label="认知树的空间视图：拖动平移，滚轮缩放，点击判断查看，双击推近。"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          {(['premise', 'example', 'conflict'] as const).map((kind) => (
            <marker
              key={kind}
              id={'ct-arrow-' + kind}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0.5,1 L7,4 L0.5,7 L2,4 z" fill={'var(--ct-' + kind + ')'} />
            </marker>
          ))}
        </defs>
        <g transform={'translate(' + cam.x + ',' + cam.y + ') scale(' + k + ')'}>
          {/* 树边 */}
          <g className="ct-space__edges">
            {nodes.map(({ id, pt, n }) => {
              if (!n.parentId) return null;
              const pp = pos.get(n.parentId);
              const pPlaced = layout.pos.get(n.parentId);
              const cPlaced = layout.pos.get(id);
              if (!pp || !pPlaced || !cPlaced) return null;
              const parent = { ...pPlaced, x: pp.x, y: pp.y };
              const child = { ...cPlaced, x: pt.x, y: pt.y };
              const d = treeEdgePath(p.layoutMode, parent, child);
              const pruned = n.state === 'prune';
              const active = !!p.selectedId && (chainSet.has(id) || n.parentId === p.selectedId);
              const dim = !!p.selectedId && !active;
              const depth = cPlaced.depth;
              const arrived = p.arrivedIds.has(id);
              const cut = pruned ? cutFor(parent, child) : null;
              return (
                <g
                  key={id}
                  className="ct-edge-g"
                  style={{ '--delay': intro ? depth * 90 + 'ms' : '0ms' } as CSSProperties}
                >
                  <path
                    d={d}
                    pathLength={1}
                    className={
                      'ct-edge' +
                      (pruned ? ' is-prune' : '') +
                      (active ? ' is-active' : '') +
                      (dim ? ' is-dim' : '') +
                      (intro ? ' is-intro' : '') +
                      (arrived ? ' is-arrived' : '') +
                      (isAiProposed(n) ? ' is-ai' : '')
                    }
                  />
                  {cut && <circle className="ct-edge__gap" cx={cut.x} cy={cut.y} r={4.6} fill="var(--ct-ground)" />}
                </g>
              );
            })}
          </g>

          {/* 引用弧：只在悬停或选中时出现，箭头保留原方向 */}
          <g className="ct-space__refs">
            {activeRefs.map((r) => {
              const a = pos.get(r.from);
              if (!a) return null;
              if (r.target.nodeId !== undefined) {
                const b = pos.get(r.target.nodeId);
                if (!b) return null;
                const arc = refArc(a, b, 0.24);
                const tag = REF_KIND[r.kind].short + (r.target.part ? ' · ' + partLabel(r.target.part) : '');
                return (
                  <g key={r.id} className={'ct-ref is-' + r.kind}>
                    <path d={arc.d} className="ct-ref__path" markerEnd={'url(#ct-arrow-' + r.kind + ')'} />
                    <text x={arc.mid.x} y={arc.mid.y - 4} textAnchor="middle" className="ct-ref__tag">
                      {tag}
                    </text>
                  </g>
                );
              }
              // 外部材料不在空间里画：出处统一在阅读栏的依据里打开，避免和标签、树枝抢位置。
              return null;
            })}
          </g>

          {/* 判断节点 */}
          <g className="ct-space__nodes">
            {nodes.map(({ id, pt, n }) => {
              const isRoot = id === p.rootId;
              const selected = id === p.selectedId;
              const dim = focusSet ? !focusSet.has(id) : false;
              const highlighted = highlightSet.has(id) && !selected;
              return (
                <g
                  key={id}
                  transform={'translate(' + pt.x + ',' + pt.y + ')'}
                  className={
                    'ct-node' +
                    (selected ? ' is-selected' : '') +
                    (dim ? ' is-dim' : '') +
                    (n.state === 'prune' ? ' is-prune' : '') +
                    (isAiProposed(n) ? ' is-ai' : '') +
                    (p.roles.get(id) === 'link' ? ' is-link' : '') +
                    (highlighted ? ' is-highlight' : '') +
                    (p.arrivedIds.has(id) ? ' is-arrived' : '') +
                    (isRoot ? ' is-root' : '')
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onSelect(id);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    camApi.centerOn(pt.x, pt.y, Math.min(2.2, camApi.camRef.current.k * 1.6), 420);
                  }}
                  onPointerEnter={() => p.onHover(id)}
                  onPointerLeave={() => p.onHover(null)}
                >
                  <circle r={isRoot ? 20 : 16} className="ct-node__hit" />
                  {selected && <circle r={isRoot ? 20 : 17} className="ct-node__ring" />}
                  {highlighted && <circle r={isRoot ? 19 : 15} className="ct-node__highlight" />}
                  <g transform={isRoot ? 'scale(1.28)' : undefined}>
                    <NodeSymbol state={n.state} confirmation={confirmationView(n)} />
                  </g>
                  {buds.get(id)?.map((b) => {
                    const angle = (layout.pos.get(id)?.angle ?? 0) + (b.axis === 'children' ? 0.85 : -0.85);
                    const r = isRoot ? 38 : 28;
                    return (
                      <g
                        key={b.axis}
                        transform={'translate(' + Math.cos(angle) * r + ',' + Math.sin(angle) * r + ')'}
                        className={'ct-bud is-' + b.kind + ' is-' + b.axis}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          p.onExpand(id, b.axis, b.kind);
                        }}
                      >
                        <title>
                          {(b.kind === 'scope' ? '参数范围到此' : '预算先到') +
                            (b.axis === 'children' ? '：这里还有子判断没有读入视野' : '：这里还有引用没有读入视野')}
                          （点击{ b.kind === 'scope' ? '展开一层' : '续读'}）
                        </title>
                        <circle r="11" className="ct-bud__hit" />
                        <text y="3.5" textAnchor="middle" className="ct-bud__mark">
                          {b.axis === 'children' ? '+' : '⋯'}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {/* 标签层：HTML，字号固定 13px，不随镜头缩放 */}
      <div className="ct-space__labels">
        {labels.map((l) => {
          const n = p.known.get(l.id);
          if (!n) return null;
          const cls =
            'ct-slabel' +
            (l.root ? ' is-root' : '') +
            (l.id === p.selectedId ? ' is-selected' : '') +
            (chainSet.has(l.id) ? ' is-chain' : '') +
            (focusSet && !focusSet.has(l.id) ? ' is-dim' : '') +
            (n.state === 'prune' ? ' is-prune' : '') +
            (isAiProposed(n) ? ' is-ai' : '') +
            (p.roles.get(l.id) === 'link' ? ' is-link' : '') +
            (highlightSet.has(l.id) ? ' is-highlight' : '') +
            (p.arrivedIds.has(l.id) ? ' is-arrived' : '') +
            (intro ? ' is-intro' : '');
          const depth = layout.pos.get(l.id)?.depth ?? 1;
          return (
            <div
              key={l.id}
              data-id={l.id}
              className={cls}
              style={{
                left: l.left,
                top: l.top,
                width: l.width,
                textAlign: l.align,
                '--delay': intro ? depth * 90 + 150 + 'ms' : '0ms',
              } as CSSProperties}
              title={n.title}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                p.onSelect(l.id);
              }}
              onPointerEnter={() => p.onHover(l.id)}
              onPointerLeave={() => p.onHover(null)}
            >
              {originMark(n.origin) && <span className="ct-slabel__origin">{originMark(n.origin)}</span>}
              {l.lines.map((line, i) => (
                <span key={i} className="ct-slabel__line">
                  {line}
                </span>
              ))}
            </div>
          );
        })}
      </div>

      {tip && (
        <div className="ct-spacetip" style={{ left: tip.left, top: tip.top }} role="tooltip">
          <div className="ct-spacetip__title">{tip.node.title}</div>
          <div className="ct-spacetip__state">
            {stateLabel(tip.node.state)} · {confirmationLabel(confirmationView(tip.node))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 子节点从父节点当前显示位置长出来；父节点还不可见时再往上找。
 * @param knownRef 已读节点
 */
function makeSpawnFrom(knownRef: MutableRefObject<Map<NodeId, ViewNode>>) {
  return (id: string, cur: Map<string, Pt>): Pt | undefined => {
    let pid = knownRef.current.get(id)?.parentId ?? null;
    while (pid) {
      const pp = cur.get(pid);
      if (pp) return pp;
      pid = knownRef.current.get(pid)?.parentId ?? null;
    }
    return undefined;
  };
}

interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 两个屏幕矩形合并成外包框。
 * @param a 矩形
 * @param b 矩形
 */
function unionBox(a: ScreenBox, b: ScreenBox): ScreenBox {
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

/**
 * 目标连同标签是否完全落在四边留白内；出界时返回把它的最小外接框带回留白区所需的最小平移。
 * 返回 (0, 0) 表示镜头不应该动。
 * @param box 目标在舞台坐标里的外接框
 * @param width 舞台宽
 * @param height 舞台高
 * @param margin 四边留白
 */
function panCorrection(box: ScreenBox, width: number, height: number, margin: number): { dx: number; dy: number } {
  const right = width - margin;
  const bottom = height - margin;
  let dx = 0;
  let dy = 0;
  if (box.left < margin) dx = margin - box.left;
  else if (box.right > right) dx = right - box.right;
  if (box.top < margin) dy = margin - box.top;
  else if (box.bottom > bottom) dy = bottom - box.bottom;
  return { dx, dy };
}

/**
 * 标签被收起或已在舞台外时，按首选方位估一个屏幕矩形，供镜头判断是否需要平移。
 * @param title 判断标题
 * @param angle 节点径向角度
 * @param sx 节点屏幕 x
 * @param sy 节点屏幕 y
 * @param root 是否根问题
 * @param labelFont 标签实际字号
 * @param rootFont 根标签实际字号
 */
function approxLabelBox(title: string, angle: number, sx: number, sy: number, root: boolean, labelFont: number, rootFont: number): ScreenBox {
  if (root) {
    // 根标签的候选含上下左右；取四者的外包，宁可多让一点。
    const halfW = Math.round(rootFont * 16);
    const halfH = Math.round(rootFont * 4.9);
    return { left: sx - halfW, top: sy - halfH, right: sx + halfW, bottom: sy + halfH };
  }
  const width = Math.min(Math.round(labelFont * 12), Math.max(Math.round(labelFont * 3.4), textWidth(clip(title, 14), labelFont) + 4));
  const h = Math.round(labelFont * 3.08);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  if (Math.abs(ca) >= 0.5) {
    return ca > 0
      ? { left: sx + 17, top: sy - h / 2, right: sx + 17 + width, bottom: sy + h / 2 }
      : { left: sx - 17 - width, top: sy - h / 2, right: sx - 17, bottom: sy + h / 2 };
  }
  return sa > 0
    ? { left: sx - width / 2, top: sy + 18, right: sx + width / 2, bottom: sy + 18 + h }
    : { left: sx - width / 2, top: sy - 18 - h, right: sx + width / 2, bottom: sy - 18 };
}

/**
 * 给外包框加一圈世界余量。
 * @param b 原始外包框
 * @param pad 每侧余量
 */
function padBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, pad: number) {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/**
 * 节点符号：外轮廓表示确认程度，内部图形表示分支状态。
 * @param props.state 分支状态
 * @param props.confirmation 显示用的确认程度（由 confirmation + currentChange 派生）
 */
function NodeSymbol(props: { state: ViewNode['state']; confirmation: ConfirmationView }) {
  return (
    <>
      {props.confirmation === 'humanConfirmed' && <circle className="ct-sym__ring" r="10.6" fill="none" stroke="var(--ct-ink-3)" strokeWidth="0.9" />}
      {props.confirmation === 'proposed' && (
        <circle className="ct-sym__ring" r="10.6" fill="none" stroke="var(--ct-ai)" strokeWidth="1" strokeDasharray="2 2.2" />
      )}
      {props.state === 'keep' && <circle r="4.4" fill="var(--ct-keep)" />}
      {props.state === 'open' && (
        // 缺口细环：圆心必须在节点原点。路径按 24×24 图标坐标写出，这里平移 (-12,-12)，
        // 否则整个符号会偏到节点右下方，压住标签。
        <g transform="translate(-12 -12)">
          <path d="M16.33 9.5 A5 5 0 1 1 12 7" fill="none" stroke="var(--ct-open)" strokeWidth="1.2" strokeLinecap="round" />
        </g>
      )}
      {props.state === 'prune' && (
        <>
          <circle r="5" fill="none" stroke="var(--ct-prune)" strokeWidth="0.9" />
          <path d="M-4.4 4.4 L4.4 -4.4" stroke="var(--ct-prune)" strokeWidth="0.9" strokeLinecap="round" />
        </>
      )}
      {props.state === undefined && (
        <path d="M0 -4.6 L4.6 0 L0 4.6 L-4.6 0 Z" fill="none" stroke="var(--ct-unknown)" strokeWidth="0.9" />
      )}
    </>
  );
}

/**
 * 把标题折成最多两行。
 * @param text 文本
 * @param width 可用宽度（px）
 * @param font 字号（px）
 */
function wrapLines(text: string, width: number, font: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of Array.from(text)) {
    const next = cur + ch;
    if (cur && textWidth(next, font) > width) {
      lines.push(cur);
      cur = ch;
      if (lines.length === 2) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < 2) lines.push(cur);
  return lines.length ? lines : [text];
}

/**
 * 计算标签候选框并按优先级避让。
 *
 * 优先级：悬停 > 选中 > 根 > 推导链（浅的优先）> 浅层。被保留的标签不与已有标签、
 * 节点符号或树枝线段相交；放不下的标签暂时隐藏（悬停该节点仍能看到全文与 ID）。
 *
 * @param args 节点屏幕位置、选中与推导链、镜头状态
 * @returns 要渲染的标签（屏幕坐标）
 */
function placeLabels(args: {
  nodes: { id: string; pt: Placed; n: ViewNode }[];
  screen: Map<NodeId, ScreenPt>;
  rootId: NodeId;
  selectedId: NodeId | null;
  chainSet: Set<NodeId>;
  k: number;
  cam: { x: number; y: number; k: number };
  stage: { width: number; height: number };
  labelFont: number;
  rootFont: number;
  layoutMode: LayoutMode;
}): LabelCandidate[] {
  const { nodes, screen, rootId, selectedId, chainSet } = args;
  const font = args.labelFont;
  const rootFont = args.rootFont;
  const lineH = Math.round(font * 1.45);
  const rootLineH = Math.round(rootFont * 1.4);
  const edgeSegs = collectEdgeSegments(nodes, screen, args.cam, args.k, args.layoutMode);
  const nodeBoxes = nodes.map(({ id }) => {
    const s = screen.get(id)!;
    return { id, x: s.x - 13, y: s.y - 13, w: 26, h: 26 };
  });

  const cands = nodes.flatMap(({ id, pt, n }) => {
    const s = screen.get(id)!;
    const root = id === rootId;
    if (root) {
      const lines = wrapLines(n.title, Math.round(rootFont * 14), rootFont);
      const width = Math.min(Math.round(rootFont * 14.2), Math.max(...lines.map((l) => textWidth(l, rootFont))) + 4);
      const h = lines.length * rootLineH + 2;
      // 根标签必须紧贴根节点：只试正下方与正上方，不放到侧边去躲树枝。
      const variants: { left: number; top: number; align: LabelCandidate['align'] }[] = [
        { left: s.x - width / 2, top: s.y + 26, align: 'center' },
        { left: s.x - width / 2, top: s.y - 26 - h, align: 'center' },
        { left: s.x + 34, top: s.y - h / 2, align: 'left' },
        { left: s.x - 34 - width, top: s.y - h / 2, align: 'right' },
      ];
      return variants.map(
        (v): LabelCandidate => ({
          id,
          root: true,
          lines,
          left: v.left,
          top: v.top,
          width,
          align: v.align,
          box: { x: v.left - 2, y: v.top - 1, w: width + 4, h: h + 2 },
        }),
      );
    }
    const short = clip(n.title, 14);
    const width = Math.min(Math.round(font * 12), Math.max(Math.round(font * 3.4), textWidth(short, font) + 4));
    const lines = wrapLines(short, width - 4, font);
    const h = lines.length * lineH + 2;
    const ca = Math.cos(pt.angle);
    const sa = Math.sin(pt.angle);
    // 首选径向外侧；若压到树枝，再试下 / 上 / 右 / 左，尽量不压线、不交叠。
    const preferred: { left: number; top: number; align: LabelCandidate['align'] } =
      Math.abs(ca) >= 0.5
        ? { align: ca > 0 ? 'left' : 'right', left: ca > 0 ? s.x + 17 : s.x - 17 - width, top: s.y - h / 2 }
        : { align: 'center', left: s.x - width / 2, top: sa > 0 ? s.y + 18 : s.y - 18 - h };
    const variants = [
      preferred,
      { left: s.x - width / 2, top: s.y + 18, align: 'center' as const },
      { left: s.x - width / 2, top: s.y - 18 - h, align: 'center' as const },
      { left: s.x + 17, top: s.y - h / 2, align: 'left' as const },
      { left: s.x - 17 - width, top: s.y - h / 2, align: 'right' as const },
      // 节点附近被树枝穿过时，再往外让一档；浅层标签优先保住。
      { left: s.x + 32, top: s.y - h / 2, align: 'left' as const },
      { left: s.x - 32 - width, top: s.y - h / 2, align: 'right' as const },
      { left: s.x - width / 2, top: s.y + 32, align: 'center' as const },
      { left: s.x - width / 2, top: s.y - 32 - h, align: 'center' as const },
      { left: s.x + 24, top: s.y + 22, align: 'left' as const },
      { left: s.x - 24 - width, top: s.y + 22, align: 'right' as const },
      { left: s.x + 24, top: s.y - 22 - h, align: 'left' as const },
      { left: s.x - 24 - width, top: s.y - 22 - h, align: 'right' as const },
    ];
    // 选中的标签必须看得见：实在贴着树枝时，再往外让一档。
    if (id === selectedId) {
      variants.push(
        { left: s.x + 52, top: s.y - h / 2, align: 'left' as const },
        { left: s.x - 52 - width, top: s.y - h / 2, align: 'right' as const },
        { left: s.x - width / 2, top: s.y + 52, align: 'center' as const },
        { left: s.x - width / 2, top: s.y - 52 - h, align: 'center' as const },
      );
    }
    return variants.map(
      (v): LabelCandidate => ({
        id,
        root: false,
        lines,
        left: v.left,
        top: v.top,
        width,
        align: v.align,
        box: { x: v.left - 2, y: v.top - 1, w: width + 4, h: h + 2 },
      }),
    );
  });

  const score = (c: LabelCandidate): number => {
    if (c.id === selectedId) return -900;
    if (c.root) return -850;
    const depth = nodes.find((x) => x.id === c.id)?.pt.depth ?? 1;
    if (chainSet.has(c.id)) return -500 + depth;
    return depth;
  };
  const byNode = new Map<NodeId, LabelCandidate[]>();
  for (const c of cands) {
    const list = byNode.get(c.id) ?? [];
    list.push(c);
    byNode.set(c.id, list);
  }
  const order = [...byNode.keys()].sort((a, b) => score(byNode.get(a)![0]) - score(byNode.get(b)![0]));

  const kept: LabelCandidate[] = [];
  const keptBoxes: Rect[] = [];
  const stage = args.stage;
  const inStage = (c: LabelCandidate) =>
    c.box.x >= 4 && c.box.y >= 4 && c.box.x + c.box.w <= stage.width - 4 && c.box.y + c.box.h <= stage.height - 4;
  for (const id of order) {
    const variants = byNode.get(id)!.filter(inStage);
    const forced = id === selectedId || id === rootId;
    let chosen: LabelCandidate | null = null;
    let best = Infinity;
    for (const c of variants) {
      let bad = 0;
      for (const b of keptBoxes) if (rectsOverlap(c.box, b)) bad += 10;
      for (const nb of nodeBoxes) if (nb.id !== c.id && rectsOverlap(c.box, nb)) bad += 3;
      for (const s of edgeSegs) if (segRect(s, c.box)) bad += 1;
      if (bad < best) {
        best = bad;
        chosen = c;
      }
      if (bad === 0) break;
    }
    if (!chosen) continue;
    if (!forced && best > 0) continue;
    kept.push(chosen);
    keptBoxes.push(chosen.box);
  }
  return kept;
}

/**
 * 把每条树边采样成屏幕坐标的短线段，供标签避让判断“不压树枝”。
 * @param nodes 可见节点
 * @param screen 节点屏幕位置
 */
function collectEdgeSegments(
  nodes: { id: string; pt: Placed; n: ViewNode }[],
  screen: Map<NodeId, ScreenPt>,
  cam: { x: number; y: number; k: number },
  k: number,
  mode: LayoutMode,
): EdgeSegment[] {
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const out: EdgeSegment[] = [];
  for (const { id, n } of nodes) {
    if (!n.parentId) continue;
    const parent = byId.get(n.parentId);
    const a = screen.get(n.parentId);
    const b = screen.get(id);
    if (!parent || !a || !b) continue;
    const ctrl = treeEdgeControls(mode, parent.pt, byId.get(id)!.pt);
    const steps = 10;
    let prev = a;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const w = bezierAt(ctrl, t);
      const cur = { x: w.x * k + cam.x, y: w.y * k + cam.y };
      out.push({ x1: prev.x, y1: prev.y, x2: cur.x, y2: cur.y });
      prev = cur;
    }
  }
  return out;
}

/**
 * 两个矩形是否相交。
 * @param a 矩形
 * @param b 矩形
 */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * 线段是否穿过矩形（含端点落在矩形内）。
 * @param s 线段
 * @param r 矩形
 */
function segRect(s: EdgeSegment, r: Rect): boolean {
  const inside = (x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  if (inside(s.x1, s.y1) || inside(s.x2, s.y2)) return true;
  const edges: EdgeSegment[] = [
    { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y },
    { x1: r.x + r.w, y1: r.y, x2: r.x + r.w, y2: r.y + r.h },
    { x1: r.x + r.w, y1: r.y + r.h, x2: r.x, y2: r.y + r.h },
    { x1: r.x, y1: r.y + r.h, x2: r.x, y2: r.y },
  ];
  return edges.some((e) => segsCross(s, e));
}

/**
 * 两条线段是否相交（含端点接触）。
 * @param a 线段
 * @param b 线段
 */
function segsCross(a: EdgeSegment, b: EdgeSegment): boolean {
  const d = (p: ScreenPt, q: ScreenPt, r: ScreenPt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const p = { x: a.x1, y: a.y1 };
  const q = { x: a.x2, y: a.y2 };
  const r = { x: b.x1, y: b.y1 };
  const s = { x: b.x2, y: b.y2 };
  const d1 = d(p, q, r);
  const d2 = d(p, q, s);
  const d3 = d(r, s, p);
  const d4 = d(r, s, q);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
