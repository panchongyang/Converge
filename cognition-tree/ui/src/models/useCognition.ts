/**
 * 认知数据的客户端缓存与当前视野（UI 模型层）。
 *
 * 状态归属：
 * - known / refs：UI 已读到的节点行与引用，按稳定 ID 合并；只是读投影的缓存，不是第二棵可写的树。
 * - sessions：每个读会话（当前视野 + 从边界展开的补读）累积的页；预算续读并进原会话，scope 另起会话。
 * - pulses：最近提交带来的变化，用于播放到达 / 确认 / 剪除等动效；只在提交成功后、经 watch 通知产生。
 * 协作：只经 CognitionClient 读写；写入后由 watch 通知统一读回，UI 不在本地猜测提交结果。
 * 续读：budget 边界用同一 spec + 内核游标续读，版本必须一致；scope 边界才从该节点发起新读；
 * exhausted 只表示范围内已查尽，不当未读。游标过期时明确报 viewExpired 并允许从折叠点重读。
 * 依据：接口单 3.2（readView 参数、边界、预算、续读）；watch 是 UI 端口对接口单的增补（ux.md §6.2）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Boundary,
  Budget,
  Expand,
  Focus,
  NodeId,
  Ref,
  RefId,
  Revision,
  SeedTree,
  TreeId,
  ViewNode,
} from '../types/kernel';
import type { CognitionClient, TreeChange } from '../types/ports';
import { toUiError, type UiError } from '../utils/errors';
import {
  aggregateSessions,
  appendPage,
  boundaryKey,
  coveredBoundaryKeys,
  openSession,
  removeCoveredBoundaries,
  withoutCursor,
  type ReadSpec,
  type SessionView,
} from './read-sessions';

export type { ReadSpec, SessionView } from './read-sessions';

/** 预算档位：宽松用于全景；适中、紧用于观察折叠与续读。数值是原型取值，不是负载结论。 */
export const BUDGETS: Record<'wide' | 'medium' | 'tight', Budget> = {
  wide: { maxScans: 20000, maxNodes: 2000, maxBytes: 1_000_000 },
  medium: { maxScans: 400, maxNodes: 24, maxBytes: 16_000 },
  tight: { maxScans: 80, maxNodes: 8, maxBytes: 4_000 },
};

/** 全景：从根读到叶子，每个节点的引用跳一跳，用于看整棵树。 */
export const PANORAMA: ReadSpec = {
  focus: { root: true },
  expand: { subtreeDepth: 'leaf', jumpHops: 1, direction: 'both', jumpFrom: 'expanded', afterJumpDepth: 0 },
  budget: BUDGETS.wide,
  onLimit: 'fold',
};

/** 聚焦的默认展开：看孩子一层，并沿两个方向跳一跳引用。 */
export const DEFAULT_FOCUS_EXPAND: Expand = {
  subtreeDepth: 1,
  jumpHops: 1,
  direction: 'both',
  jumpFrom: 'expanded',
  afterJumpDepth: 0,
};

/** 当前视野：全景，或以某节点为焦点按参数折出的局部树。 */
export type ViewSpec =
  | { kind: 'panorama' }
  | { kind: 'focus'; focusId: NodeId; expand: Expand; budget: Budget; onLimit: 'fold' | 'exact' };

/** 一次提交在某个节点上的可见效果。 */
export interface Pulse {
  key: string;
  nodeId: NodeId;
  effect: 'propose' | 'confirm' | 'prune' | 'revive' | 'correct' | 'replace' | 'parent';
  /** 接受替代时，新判断指向的旧判断（画替代光束）。 */
  peerId?: NodeId;
  at: number;
}

export interface CognitionState {
  /** loading 首次读取中；empty 树不存在；ready 有数据；error 读取失败。 */
  status: 'loading' | 'ready' | 'empty' | 'error';
  error: UiError | null;
  /** 聚焦读取失败（如 rangeTooLarge、续读游标过期）时保留上一次的视野，只报错。 */
  viewError: UiError | null;
  rootId: NodeId | null;
  stamp: number;
  known: Map<NodeId, ViewNode>;
  refs: Map<RefId, Ref>;
  visible: Set<NodeId>;
  roles: Map<NodeId, 'hit' | 'link'>;
  /** 所有读会话的边界；含 exhausted，界面按需过滤。 */
  boundaries: Boundary[];
  complete: boolean;
  reading: boolean;
}

const PULSE_LIFE = 2600;

function initialState(): CognitionState {
  return {
    status: 'loading',
    error: null,
    viewError: null,
    rootId: null,
    stamp: 0,
    known: new Map(),
    refs: new Map(),
    visible: new Set(),
    roles: new Map(),
    boundaries: [],
    complete: true,
    reading: true,
  };
}

function baseRead(s: ViewSpec): ReadSpec {
  return s.kind === 'panorama' ? PANORAMA : { focus: s.focusId, expand: s.expand, budget: s.budget, onLimit: s.onLimit };
}

/** 焦点若指向具体节点则给出 ID；显式选根时为 null。 */
function focusNodeId(focus: Focus): NodeId | null {
  return typeof focus === 'string' ? focus : null;
}

/**
 * 修订 → 动效。只看修订明细，不在本地推测提交结果。
 * @param revisions 本次提交新增的修订
 * @param now 动效起点（performance.now）
 */
function pulsesOf(revisions: Revision[], now: number): Pulse[] {
  const out: Pulse[] = [];
  const add = (nodeId: NodeId | undefined, effect: Pulse['effect'], r: Revision, peerId?: NodeId) => {
    if (nodeId) out.push({ key: r.id + ':' + nodeId + ':' + effect, nodeId, effect, peerId, at: now });
  };
  for (const r of revisions) {
    if (r.kind === 'confirmation') {
      r.nodeIds.forEach((id) => add(id, 'confirm', r));
      continue;
    }
    const d = r.detail;
    if (!d || !('action' in d)) continue;
    switch (d.action) {
      case 'addBranch':
        add(r.nodeIds[0], r.by === 'ai' ? 'propose' : 'correct', r);
        add(r.nodeIds[1], 'parent', r);
        break;
      case 'prune':
        r.nodeIds.forEach((id) => add(id, 'prune', r));
        break;
      case 'revive':
      case 'setOpenOrKeep':
        r.nodeIds.forEach((id) => add(id, 'revive', r));
        break;
      case 'applyReplacement': {
        add(d.replacement.newId, 'replace', r, d.replacement.oldId);
        add(d.replacement.oldId, 'prune', r);
        break;
      }
    }
  }
  return out;
}

/**
 * 认知数据模型。
 * @param client 认知端口（人侧）
 * @param treeId 当前树
 * @param onChange 每次收到树变化通知时调用（用于提示 AI 新提议等），在读回之后调用
 */
export function useCognition(client: CognitionClient, treeId: TreeId, onChange?: (change: TreeChange) => void) {
  const [state, setState] = useState<CognitionState>(initialState);
  const [spec, setSpecState] = useState<ViewSpec>({ kind: 'panorama' });
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const specRef = useRef(spec);
  specRef.current = spec;
  /** 读会话：base 为当前视野，x* 为从边界展开的补读。 */
  const sessionsRef = useRef<Map<string, SessionView>>(new Map());
  const extraSeq = useRef(0);
  const seqRef = useRef(0);
  /** 同一处边界上已在进行的续读/展开，防止连点重复消费同一个游标。 */
  const inFlightRef = useRef(new Set<string>());
  const rowStampRef = useRef(new Map<NodeId, number>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /**
   * 把读会话聚合进 UI 状态。
   * @param sessions 新的会话集合
   * @param viewError 这次读取要显示的失败说明；null 表示清掉旧说明
   */
  const commit = useCallback((sessions: Map<string, SessionView>, viewError: UiError | null = null) => {
    const agg = aggregateSessions(sessions.values());
    setState((p) => {
      const known = new Map(p.known);
      const refs = new Map(p.refs);
      for (const session of sessions.values()) {
        for (const n of session.nodes.values()) {
          if (session.stamp >= (rowStampRef.current.get(n.id) ?? -1)) {
            known.set(n.id, n);
            rowStampRef.current.set(n.id, session.stamp);
          }
        }
        for (const r of session.refs.values()) refs.set(r.id, r);
      }
      return {
        ...p,
        status: 'ready',
        error: null,
        viewError,
        rootId: agg.rootId || p.rootId,
        stamp: agg.stamp,
        known,
        refs,
        visible: agg.visible,
        roles: agg.roles,
        boundaries: agg.boundaries,
        complete: agg.complete,
        reading: false,
      };
    });
  }, []);

  /** 按视野重新读取 base 与会话里已有的展开补读；补读从首屏重来，不重放旧游标。 */
  const readAll = useCallback(
    async (s: ViewSpec, extraSpecs: ReadSpec[]) => {
      const seq = ++seqRef.current;
      setState((p) => ({ ...p, reading: true }));
      const reads: { key: string; spec: ReadSpec }[] = [{ key: 'base', spec: baseRead(s) }];
      extraSpecs.forEach((spec, i) => reads.push({ key: 'x' + (i + 1), spec }));
      let sessions = new Map<string, SessionView>();
      try {
        for (const r of reads) {
          const page = await client.call('readView', { treeId, ...r.spec });
          if (seq !== seqRef.current) return;
          sessions.set(r.key, openSession(r.key, r.spec, page));
        }
      } catch (e) {
        if (seq !== seqRef.current) return;
        const err = toUiError(e);
        setState((p) => {
          if (s.kind === 'panorama' && err.code === 'missing') {
            rowStampRef.current.clear();
            sessionsRef.current = new Map();
            return { ...initialState(), status: 'empty', reading: false };
          }
          if (p.status === 'ready' && s.kind === 'focus') return { ...p, reading: false, viewError: err };
          return { ...p, status: 'error', error: err, reading: false };
        });
        return;
      }
      for (const [key] of sessions) {
        if (key === 'base') continue;
        const session = sessions.get(key)!;
        const focus = focusNodeId(session.spec.focus);
        if (focus) sessions = removeCoveredBoundaries(sessions, key, coveredBoundaryKeys(focus, session.spec.expand));
      }
      sessionsRef.current = sessions;
      extraSeq.current = Math.max(extraSeq.current, sessions.size - 1);
      commit(sessions);
    },
    [client, treeId, commit],
  );

  useEffect(() => {
    extraSeq.current = 0;
    void readAll(specRef.current, []);
  }, [readAll]);

  useEffect(
    () =>
      client.watch(treeId, (change) => {
        const now = performance.now();
        const next = pulsesOf(change.revisions, now);
        const extras = [...sessionsRef.current.values()].filter((s) => s.key !== 'base').map((s) => s.spec);
        void readAll(specRef.current, extras).then(async () => {
          const ids = [...new Set(change.revisions.flatMap((r) => r.nodeIds))];
          for (const id of ids) {
            await mergeOnly({
              focus: id,
              expand: { subtreeDepth: 0, jumpHops: 0, direction: 'out', jumpFrom: 'anchor', afterJumpDepth: 0 },
              budget: BUDGETS.wide,
              onLimit: 'fold',
            });
          }
          if (next.length) setPulses((list) => [...list.filter((p) => now - p.at < PULSE_LIFE), ...next]);
          onChangeRef.current?.(change);
        });
      }),
    // mergeOnly 只依赖 client/treeId；两者变化时 effect 会重建，避免在此提前读取它的声明。
    [client, treeId, readAll],
  );

  useEffect(() => {
    if (!pulses.length) return;
    const t = window.setTimeout(
      () => setPulses((list) => list.filter((p) => performance.now() - p.at < PULSE_LIFE)),
      PULSE_LIFE + 50,
    );
    return () => window.clearTimeout(t);
  }, [pulses]);

  /**
   * 只把读到的行并入缓存（不改变视野），例如为阅读栏补齐邻居、为新提议补节点行。
   * @param spec 补读参数
   */
  const mergeOnly = useCallback(
    async (spec: ReadSpec) => {
      try {
        const v = await client.call('readView', { treeId, ...spec });
        setState((p) => {
          const known = new Map(p.known);
          const refs = new Map(p.refs);
          for (const n of v.nodes) {
            if (v.stamp >= (rowStampRef.current.get(n.id) ?? -1)) {
              known.set(n.id, n);
              rowStampRef.current.set(n.id, v.stamp);
            }
          }
          for (const r of v.refs) refs.set(r.id, r);
          return { ...p, known, refs };
        });
      } catch {
        // 补读失败不影响当前视野；阅读栏会显示自己的读取状态。
      }
    },
    [client, treeId],
  );

  /**
   * 切换视野；丢掉之前的展开补读与游标。
   * @param s 新视野
   */
  const setSpec = useCallback(
    (s: ViewSpec) => {
      extraSeq.current = 0;
      setSpecState(s);
      void readAll(s, []);
    },
    [readAll],
  );

  /**
   * 边界展开的实现：budget 走同一查询的游标续读，scope 发起新的焦点读取。
   * @param nodeId 边界节点
   * @param axis children / refs
   * @param kind 边界种类
   * @param key 边界键
   */
  const expandAtBoundary = useCallback(
    async (nodeId: NodeId, axis: 'children' | 'refs', kind: 'scope' | 'exhausted' | 'budget', key: string) => {
      const owner = [...sessionsRef.current.values()].reverse().find((s) => s.boundaries.has(key));
      if (kind === 'budget' && owner?.cursor) {
        setState((p) => ({ ...p, reading: true }));
        try {
          const page = await client.call('readView', { treeId, ...owner.spec, cursor: owner.cursor });
          const next = appendPage(owner, page, key);
          if (!next) {
            const err: UiError = { code: 'viewExpired', message: '续读返回了不同的版本，请从折叠点重新读取。' };
            const sessions = new Map(sessionsRef.current);
            sessions.set(owner.key, withoutCursor(owner));
            sessionsRef.current = sessions;
            commit(sessions, err);
            return;
          }
          const sessions = new Map(sessionsRef.current);
          sessions.set(owner.key, next);
          sessionsRef.current = sessions;
          commit(sessions);
        } catch (e) {
          // 游标失败即失效；保留已经读到的部分，下次点击从折叠点重新读取。
          const sessions = new Map(sessionsRef.current);
          sessions.set(owner.key, withoutCursor(owner));
          sessionsRef.current = sessions;
          commit(sessions, toUiError(e));
        }
        return;
      }
      // scope（或游标已失效的 budget）：从该边界节点发起一次新的读取。
      const current = specRef.current;
      const budget = current.kind === 'focus' ? current.budget : BUDGETS.wide;
      const direction = current.kind === 'focus' ? current.expand.direction : 'both';
      const spec: ReadSpec = {
        focus: nodeId,
        expand:
          axis === 'children'
            ? { subtreeDepth: 1, jumpHops: 0, direction, jumpFrom: 'anchor', afterJumpDepth: 0 }
            : { subtreeDepth: 0, jumpHops: 1, direction, jumpFrom: 'anchor', afterJumpDepth: 0 },
        budget,
        onLimit: 'fold',
      };
      setState((p) => ({ ...p, reading: true }));
      try {
        const page = await client.call('readView', { treeId, ...spec });
        const readKey = 'x' + ++extraSeq.current;
        let sessions = new Map(sessionsRef.current);
        sessions.set(readKey, openSession(readKey, spec, page));
        sessions = removeCoveredBoundaries(sessions, readKey, coveredBoundaryKeys(nodeId, spec.expand));
        sessionsRef.current = sessions;
        commit(sessions);
      } catch (e) {
        setState((p) => ({ ...p, reading: false, viewError: toUiError(e) }));
      }
    },
    [client, treeId, commit],
  );

  /**
   * 从边界标记继续：预算先到时用同一查询与游标续读；参数范围到此才发起新的焦点读取。
   * @param nodeId 带边界标记的节点
   * @param axis children 读孩子，refs 读引用
   * @param kind 边界种类；exhausted 不应发起续读
   */
  const expandAt = useCallback(
    async (nodeId: NodeId, axis: 'children' | 'refs', kind: 'scope' | 'exhausted' | 'budget' = 'scope') => {
      if (kind === 'exhausted') return;
      const key = boundaryKey({ nodeId, axis });
      if (inFlightRef.current.has(key)) return;
      inFlightRef.current.add(key);
      try {
        await expandAtBoundary(nodeId, axis, kind, key);
      } finally {
        inFlightRef.current.delete(key);
      }
    },
    [expandAtBoundary],
  );

  /**
   * 为阅读栏补齐一个节点的孩子与两向引用（只进缓存，不改视野）。
   * @param nodeId 选中的节点
   */
  const ensureNeighborhood = useCallback(
    (nodeId: NodeId) =>
      mergeOnly({
        focus: nodeId,
        expand: { subtreeDepth: 1, jumpHops: 1, direction: 'both', jumpFrom: 'anchor', afterJumpDepth: 0 },
        budget: BUDGETS.wide,
        onLimit: 'fold',
      }),
    [mergeOnly],
  );

  /** 按当前视野重新读取；已展开的补读从首屏重来。 */
  const reload = useCallback(() => {
    const extras = [...sessionsRef.current.values()].filter((s) => s.key !== 'base').map((s) => s.spec);
    void readAll(specRef.current, extras);
  }, [readAll]);

  /**
   * 由人发起的一次性自举；成功后经 watch 读回。
   * @param seed 适配器提供的种子
   * @throws 端口的业务错误（例如树已存在）
   */
  const bootstrap = useCallback(
    async (seed: SeedTree) => {
      await client.call('bootstrapTree', { seed });
      void readAll(specRef.current, []);
    },
    [client, readAll],
  );

  return { state, spec, setSpec, expandAt, ensureNeighborhood, reload, bootstrap, pulses };
}

export type CognitionModel = ReturnType<typeof useCognition>;
