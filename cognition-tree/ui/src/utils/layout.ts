/**
 * 空间视图的径向布局（纯计算，不认识 React/DOM）。
 *
 * 根问题在原点，判断按层向外生长；子树按叶子数分得角度，孩子按稳定 ID 自然序排列。
 * 布局在 UI 已读到的全部节点上计算，因此切换焦点或视野时，同一节点的位置不变——
 * 人在空间里形成的位置记忆不会因为换了一种读法而丢失。抖动由节点 ID 的哈希决定，刷新不变。
 */
import { compareIds, hash01 } from './ids';

export interface LayoutNode {
  id: string;
  parentId: string | null;
}

export interface Placed {
  x: number;
  y: number;
  /** 从原点看过去的方向（弧度），标签据此放在节点外侧。 */
  angle: number;
  depth: number;
}

export interface LayoutResult {
  pos: Map<string, Placed>;
  /** 每一层轨道的半径，下标即深度。 */
  rings: number[];
  /** 所有节点的外包框（世界坐标）。 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** 空间的图布局：径向（根在中央）、横向树（根在左）、纵向树（根在上）。都只由已读节点决定。 */
export type LayoutMode = 'radial' | 'horizontal' | 'vertical';

/** 布局常数：第一圈半径、圈距、每片叶子最少占的弧长（世界坐标，单位近似 px）。 */
const RING0 = 175;
const RING_GAP = 140;
const MIN_LEAF_ARC = 132;

/** 分层布局常数：每层间距、每个叶槽的间距、抖动幅度（世界坐标）。 */
const LAYER_GAP = 250;
const SIBLING_GAP = 92;
const LAYER_JITTER = 10;

/**
 * 计算径向布局。
 * @param nodes 已读到的节点（父节点不在集合里的节点会被当作孤立根之外的遗漏而跳过）
 * @param rootId 树根 ID
 * @returns 各节点的世界坐标、轨道半径与外包框；根不在集合里时返回空布局
 */
export function radialLayout(nodes: LayoutNode[], rootId: string): LayoutResult {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId && ids.has(n.parentId)) {
      const list = children.get(n.parentId) ?? [];
      list.push(n.id);
      children.set(n.parentId, list);
    }
  }
  for (const list of children.values()) list.sort(compareIds);

  const pos = new Map<string, Placed>();
  const empty: LayoutResult = { pos, rings: [0], bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 } };
  if (!ids.has(rootId)) return empty;

  // 叶子数决定角度份额；同时记下最大深度，用来按最外圈周长约束最小弧长。
  const leaves = new Map<string, number>();
  let maxDepth = 0;
  const countLeaves = (id: string, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = children.get(id) ?? [];
    const n = kids.length === 0 ? 1 : kids.reduce((s, k) => s + countLeaves(k, depth + 1), 0);
    leaves.set(id, n);
    return n;
  };
  const total = countLeaves(rootId, 0);

  const rings: number[] = [0];
  for (let d = 1; d <= maxDepth; d++) rings.push(RING0 + (d - 1) * RING_GAP);
  // 叶子太多时把外圈推远，保证每片叶子至少 MIN_LEAF_ARC 的弧长。
  const outer = rings[maxDepth] ?? 0;
  const needed = (total * MIN_LEAF_ARC) / (Math.PI * 2);
  if (maxDepth > 0 && needed > outer) {
    const scale = needed / outer;
    for (let d = 1; d <= maxDepth; d++) rings[d] = rings[d] * scale;
  }

  const place = (id: string, a0: number, a1: number, depth: number): void => {
    const kids = children.get(id) ?? [];
    const mid = (a0 + a1) / 2;
    if (depth === 0) {
      pos.set(id, { x: 0, y: 0, angle: -Math.PI / 2, depth: 0 });
    } else {
      const h = hash01(id);
      const r = rings[depth] + (h - 0.5) * 28;
      const span = a1 - a0;
      const angle = mid + (hash01(id + '~') - 0.5) * Math.min(span * 0.18, 0.06);
      pos.set(id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r, angle, depth });
    }
    let cursor = a0;
    for (const k of kids) {
      const share = ((a1 - a0) * (leaves.get(k) ?? 1)) / (leaves.get(id) ?? 1);
      place(k, cursor, cursor + share, depth + 1);
      cursor += share;
    }
  };
  // 从左上方起顺时针排布，让第一层的分支大致分布在上、右、下。
  const start = -Math.PI * 0.95;
  place(rootId, start, start + Math.PI * 2, 0);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { pos, rings, bounds: { minX, minY, maxX, maxY } };
}

/**
 * 计算分层布局：根在左（横向）或上（纵向），每层占一列/一行，兄弟按稳定 ID 次序排开。
 *
 * 与径向布局一样只依赖已读节点：叶子各占一个槽，内部节点取孩子的槽位平均，
 * 因此同一节点在刷新后、切换视野后位置不变；抖动由 ID 哈希决定。
 *
 * @param nodes 已读节点
 * @param rootId 树根 ID
 * @param direction 横向（根在左、逐层向右）或纵向（根在上、逐层向下）
 * @returns 各节点世界坐标、每层坐标与外包框；根不在集合里时返回空布局
 */
export function layeredLayout(nodes: LayoutNode[], rootId: string, direction: 'horizontal' | 'vertical'): LayoutResult {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId && ids.has(n.parentId)) {
      const list = children.get(n.parentId) ?? [];
      list.push(n.id);
      children.set(n.parentId, list);
    }
  }
  for (const list of children.values()) list.sort(compareIds);

  const pos = new Map<string, Placed>();
  const empty: LayoutResult = { pos, rings: [0], bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 } };
  if (!ids.has(rootId)) return empty;

  // 先做一次先序：记录深度与稳定的遍历次序。
  const depth = new Map<string, number>();
  const order: string[] = [];
  const walk = (id: string, d: number): void => {
    depth.set(id, d);
    order.push(id);
    for (const k of children.get(id) ?? []) walk(k, d + 1);
  };
  walk(rootId, 0);

  const slot = new Map<string, number>();
  let next = 0;
  // 叶子各占一槽，内部节点取孩子的平均槽位。
  const assign = (id: string): number => {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      const s = next++;
      slot.set(id, s);
      return s;
    }
    let sum = 0;
    for (const k of kids) sum += assign(k);
    const s = sum / kids.length;
    slot.set(id, s);
    return s;
  };
  assign(rootId);

  const rootAt = slot.get(rootId) ?? 0;
  const rings: number[] = [];
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    const s = (slot.get(id) ?? 0) - rootAt;
    const along = (hash01(id) - 0.5) * LAYER_JITTER;
    const across = (hash01(id + '~') - 0.5) * (SIBLING_GAP * 0.3);
    rings[d] = Math.max(rings[d] ?? 0, Math.abs(s * SIBLING_GAP));
    const x = direction === 'horizontal' ? d * LAYER_GAP + along : s * SIBLING_GAP + across;
    const y = direction === 'horizontal' ? s * SIBLING_GAP + across : d * LAYER_GAP + along;
    const angle = direction === 'horizontal' ? 0 : Math.PI / 2;
    pos.set(id, { x, y, angle, depth: d });
  }
  // 根移到原点，取景与“看全”复用同一套平移逻辑。
  const rp = pos.get(rootId)!;
  for (const point of pos.values()) {
    point.x -= rp.x;
    point.y -= rp.y;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of pos.values()) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { pos, rings, bounds: { minX, minY, maxX, maxY } };
}

/**
 * 按模式计算布局。
 * @param mode 图布局模式
 * @param nodes 已读节点
 * @param rootId 树根 ID
 */
export function layoutTree(mode: LayoutMode, nodes: LayoutNode[], rootId: string): LayoutResult {
  return mode === 'radial' ? radialLayout(nodes, rootId) : layeredLayout(nodes, rootId, mode);
}

/**
 * 树边的三次贝塞尔控制点：控制点沿各自方向取两圈中点，让细线顺着推导方向弯出去。
 * @param p 父节点（当前显示位置 + 布局方向）
 * @param c 子节点（当前显示位置 + 布局方向）
 * @returns 起点、两个控制点、终点
 */
export function treeEdgeControls(mode: LayoutMode, p: Placed, c: Placed): [Pt2, Pt2, Pt2, Pt2] {
  // 分层布局：控制点落在父子连线的中段，线从父节点水平（或垂直）伸出再收进子节点。
  if (mode === 'horizontal') {
    const mx = (p.x + c.x) / 2;
    return [{ x: p.x, y: p.y }, { x: mx, y: p.y }, { x: mx, y: c.y }, { x: c.x, y: c.y }];
  }
  if (mode === 'vertical') {
    const my = (p.y + c.y) / 2;
    return [{ x: p.x, y: p.y }, { x: p.x, y: my }, { x: c.x, y: my }, { x: c.x, y: c.y }];
  }
  const rp = Math.hypot(p.x, p.y);
  const rc = Math.hypot(c.x, c.y);
  const rm = (rp + rc) / 2;
  const c1 = p.depth === 0
    ? { x: Math.cos(c.angle) * rm * 0.55, y: Math.sin(c.angle) * rm * 0.55 }
    : { x: Math.cos(p.angle) * rm, y: Math.sin(p.angle) * rm };
  const c2 = { x: Math.cos(c.angle) * rm, y: Math.sin(c.angle) * rm };
  return [{ x: p.x, y: p.y }, c1, c2, { x: c.x, y: c.y }];
}

/**
 * 树边的 SVG 路径（父 → 子）。
 * @param p 父节点位置
 * @param c 子节点位置
 */
export function treeEdgePath(mode: LayoutMode, p: Placed, c: Placed): string {
  const [a, c1, c2, b] = treeEdgeControls(mode, p, c);
  return 'M' + f(a.x) + ',' + f(a.y) + 'C' + f(c1.x) + ',' + f(c1.y) + ' ' + f(c2.x) + ',' + f(c2.y) + ' ' + f(b.x) + ',' + f(b.y);
}

/**
 * 三次贝塞尔曲线上参数 t 处的点（用于在树边上放剪除标记）。
 * @param pts treeEdgeControls 的结果
 * @param t 0–1
 */
export function bezierAt(pts: [Pt2, Pt2, Pt2, Pt2], t: number): Pt2 {
  const u = 1 - t;
  const [a, b, c, d] = pts;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

export interface Pt2 {
  x: number;
  y: number;
}

/**
 * 引用弧：两点之间向外侧弯的二次曲线；返回路径和曲线中点（放类型标签）。
 * @param a 引用起点（from）
 * @param b 引用终点（target）
 * @param bend 弯曲程度，取 0–0.5
 */
export function refArc(a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.28) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // 法线方向取远离原点的一侧，弧线绕开树的中心区域。
  let nx = -dy / len;
  let ny = dx / len;
  if (nx * mx + ny * my < 0) {
    nx = -nx;
    ny = -ny;
  }
  const cx = mx + nx * len * bend;
  const cy = my + ny * len * bend;
  const midX = 0.25 * a.x + 0.5 * cx + 0.25 * b.x;
  const midY = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
  return { d: 'M' + f(a.x) + ',' + f(a.y) + 'Q' + f(cx) + ',' + f(cy) + ' ' + f(b.x) + ',' + f(b.y), mid: { x: midX, y: midY } };
}

/**
 * 从某节点沿真实父链回到根，返回从根到它的 ID 序列（推导链）。
 * @param id 起点节点
 * @param parentOf 查父节点；查不到时停止
 */
export function chainToRoot(id: string, parentOf: (id: string) => string | null | undefined): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (let cur: string | null | undefined = id; cur && !seen.has(cur); cur = parentOf(cur)) {
    seen.add(cur);
    chain.push(cur);
  }
  return chain.reverse();
}

function f(n: number): string {
  return n.toFixed(1);
}
