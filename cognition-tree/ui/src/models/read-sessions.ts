/**
 * 读会话：把 readView 的一页页结果按查询累积起来（纯计算，不认识 React）。
 *
 * 职责：
 * - 首屏建立会话；预算先到时用同一 spec + 内核游标续读，后续页并入同一会话；
 * - 续读必须与会话同一 stamp（游标绑定同一读快照），不同版本不拼接；
 * - 会话保存自己的节点、引用与边界；聚合出 UI 要画的可见集合、边界归属和游标。
 * 边界：只管读投影的合并，不解释树业务、不改写节点事实；不保存正文。
 * 协作：useCognition 持有会话并调用这里；空间/大纲/阅读栏按边界标记发起 scope 或 budget。
 * 依据：docs/design/kernel-interfaces.md §3.2（范围、预算、边界、续读与 viewExpired）。
 */
import type {
  Boundary,
  Budget,
  Expand,
  Focus,
  NodeId,
  Ref,
  RefId,
  TreeView,
  ViewNode,
} from '../types/kernel';

/** 一次 readView 的请求参数（树 ID 之外）；续读必须原样带回同一份。 */
export interface ReadSpec {
  focus: Focus;
  expand: Expand;
  budget: Budget;
  onLimit: 'fold' | 'exact';
}

/** 一个读会话：同一次查询的首屏与所有续读页。 */
export interface SessionView {
  /** 会话键：base 是当前视野，x* 是从边界展开出的补读。 */
  readonly key: string;
  readonly spec: ReadSpec;
  /** 本会话所基于的已提交版本；续读页必须与它相同。 */
  readonly stamp: number;
  /** 树根；同一棵树的所有会话一致。 */
  readonly rootId: NodeId;
  /** 下一页游标；没有时表示已读完或需要重新读取。 */
  readonly cursor?: string;
  /** 累计是否已覆盖请求范围（取最后一页）。 */
  readonly complete: boolean;
  readonly nodes: ReadonlyMap<NodeId, ViewNode>;
  readonly refs: ReadonlyMap<RefId, Ref>;
  readonly boundaries: ReadonlyMap<string, Boundary>;
}

/** 边界的稳定键：节点 + 方向。聚合时按它去重与找归属。 */
export function boundaryKey(b: Pick<Boundary, 'nodeId' | 'axis'>): string {
  return b.nodeId + ':' + b.axis;
}

/** 把一页的节点、引用、边界并入映射（同 ID 后读到的行覆盖先前的）。 */
function mergePage(before: {
  nodes: ReadonlyMap<NodeId, ViewNode>;
  refs: ReadonlyMap<RefId, Ref>;
  boundaries: ReadonlyMap<string, Boundary>;
}, page: TreeView, replacedBoundary?: string): {
  nodes: Map<NodeId, ViewNode>;
  refs: Map<RefId, Ref>;
  boundaries: Map<string, Boundary>;
} {
  const nodes = new Map(before.nodes);
  const refs = new Map(before.refs);
  const boundaries = new Map(before.boundaries);
  for (const n of page.nodes) {
    // 续读页可能只为连通而带出前页已命中的节点；同为一次查询时保留 hit，不降级为 link。
    const prev = nodes.get(n.id);
    nodes.set(n.id, prev?.role === 'hit' || n.role === 'hit' ? { ...n, role: 'hit' } : n);
  }
  for (const r of page.refs) refs.set(r.id, r);
  // 续读只补上预算边界；如果该处已经查尽，不因续读页里的 scope 降级。
  if (replacedBoundary && boundaries.get(replacedBoundary)?.kind !== 'exhausted') boundaries.delete(replacedBoundary);
  for (const b of page.boundaries) {
    const key = boundaryKey(b);
    const old = boundaries.get(key);
    // 与内核同一规则：已查尽覆盖较早的 scope，反过来不降级。
    if (old?.kind === 'exhausted' && b.kind === 'scope') continue;
    boundaries.set(key, b);
  }
  return { nodes, refs, boundaries };
}

/**
 * 用首屏建立会话。
 * @param key 会话键
 * @param spec 这次查询的参数（续读必须相同）
 * @param page 首屏结果
 */
export function openSession(key: string, spec: ReadSpec, page: TreeView): SessionView {
  return {
    key,
    spec,
    stamp: page.stamp,
    rootId: page.rootId,
    cursor: page.cursor,
    complete: page.complete,
    ...mergePage({ nodes: new Map(), refs: new Map(), boundaries: new Map() }, page),
  };
}

/**
 * 续读：把同一查询的下一页并入会话。
 *
 * 返回 null 表示这一页不是同一版本（不能拼页）；调用方应报 viewExpired 或重新读取。
 * @param session 原会话
 * @param page 续读结果
 * @param replacedBoundary 本次续读填上的边界键；先移除再合入本页边界
 */
export function appendPage(session: SessionView, page: TreeView, replacedBoundary?: string): SessionView | null {
  if (page.stamp !== session.stamp) return null;
  return {
    ...session,
    cursor: page.cursor,
    complete: page.complete,
    ...mergePage(session, page, replacedBoundary),
  };
}

/**
 * 清掉会话的续读游标；已在路上的遍历不能继续，边界保留供人重读。
 * @param session 原会话
 */
export function withoutCursor(session: SessionView): SessionView {
  return { ...session, cursor: undefined };
}

/**
 * 一次展开会覆盖哪些边界：读到孩子层就不再标 children 的“参数到此”，
 * 读了一跳引用就不再标 refs 的“参数到此”。
 * @param focusId 展开的焦点
 * @param expand 本次展开参数
 * @returns 边界键
 */
export function coveredBoundaryKeys(focusId: NodeId, expand: Expand): string[] {
  const keys: string[] = [];
  if (expand.subtreeDepth === 'leaf' || expand.subtreeDepth >= 1) keys.push(focusId + ':children');
  if (expand.jumpHops >= 1) keys.push(focusId + ':refs');
  return keys;
}

/**
 * 从其它会话里移除已被新展开覆盖的边界；保留发起本次展开的会话自己页内的边界。
 * @param sessions 会话集合
 * @param keepKey 本次新会话的键
 * @param keys 要移除的边界键
 */
export function removeCoveredBoundaries(
  sessions: Map<string, SessionView>,
  keepKey: string,
  keys: string[],
): Map<string, SessionView> {
  const out = new Map<string, SessionView>();
  for (const [key, session] of sessions) {
    if (key === keepKey || keys.length === 0) {
      out.set(key, session);
      continue;
    }
    const boundaries = new Map(session.boundaries);
    for (const k of keys) boundaries.delete(k);
    out.set(key, { ...session, boundaries });
  }
  return out;
}

/** 会话聚合后交给 UI 的读投影。 */
export interface AggregatedReads {
  rootId: NodeId;
  /** 所有会话里最新的版本；版本号显示与读回 trigger 用它。 */
  stamp: number;
  /** 同一时刻只有一个版本可用；混版本时由调用方拒绝拼接，这里仍取最大 stamp。 */
  known: Map<NodeId, ViewNode>;
  refs: Map<RefId, Ref>;
  visible: Set<NodeId>;
  roles: Map<NodeId, 'hit' | 'link'>;
  /** 所有会话的边界；含 exhausted，界面按需过滤。 */
  boundaries: Boundary[];
  /** 边界键 → 会话键，用来找是哪次读取给了续读游标。 */
  boundaryOwner: Map<string, string>;
  /** 会话键 → 当前游标。 */
  cursors: Map<string, string>;
  /** 所有会话都读完时为 true。 */
  complete: boolean;
}

/**
 * 聚合多个读会话。
 * 节点行按会话版本取新：版本高者覆盖低者；同版本后加入的会话（展开补读）覆盖先前的。
 * @param sessions 会话集合，按建立顺序迭代
 */
export function aggregateSessions(sessions: Iterable<SessionView>): AggregatedReads {
  const known = new Map<NodeId, ViewNode>();
  const refs = new Map<RefId, Ref>();
  const visible = new Set<NodeId>();
  const roles = new Map<NodeId, 'hit' | 'link'>();
  const boundaries = new Map<string, Boundary>();
  const boundaryOwner = new Map<string, string>();
  const rowStamp = new Map<NodeId, number>();
  const cursors = new Map<string, string>();
  let rootId: NodeId | null = null;
  let stamp = 0;
  let complete = true;
  for (const session of sessions) {
    if (rootId === null) rootId = session.rootId;
    stamp = Math.max(stamp, session.stamp);
    complete = complete && session.complete;
    if (session.cursor !== undefined) cursors.set(session.key, session.cursor);
    for (const n of session.nodes.values()) {
      if ((rowStamp.get(n.id) ?? -1) > session.stamp) continue;
      known.set(n.id, n);
      rowStamp.set(n.id, session.stamp);
      visible.add(n.id);
      roles.set(n.id, roles.get(n.id) === 'hit' || n.role === 'hit' ? 'hit' : 'link');
    }
    for (const r of session.refs.values()) refs.set(r.id, r);
    for (const [key, b] of session.boundaries) {
      boundaries.set(key, b);
      boundaryOwner.set(key, session.key);
    }
  }
  return {
    rootId: rootId ?? '',
    stamp,
    known,
    refs,
    visible,
    roles,
    boundaries: [...boundaries.values()],
    boundaryOwner,
    cursors,
    complete,
  };
}
