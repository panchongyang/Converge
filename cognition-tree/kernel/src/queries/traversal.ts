/**
 * 按稳定索引键推进的局部树遍历。每次最多向端口取一条邻接行，空查、重复边及父链查找均计费。
 * 状态只随已经检查的行增长；不先加载节点表/引用表，也不读取长正文。每个连接路径原子投影。
 * 同一节点按“深度、剩余跳数、是否可起跳”的非支配状态去重，不把首次命中当作全范围已覆盖。
 */
import { CognitionError } from '../types/index';
import type { Boundary, Budget, Depth, Expand, NodeRow, ReadSnapshot, Ref, TreeView } from '../types/index';
import { compareIds } from '../utils/index';
import { ViewPage, type OutputLimit, type Projection, type ViewWireCost } from './view-page';

/** 超限处实测的限制项；扫描在下一次实际访问前停止，不猜最终需求。 */
type ViewLimit = OutputLimit & { maxScans?: true };

/**
 * 报告本次真实受限的预算项，只有确定是下界的输出成本才给带单位的数字。
 * @param limit 实际越过的预算（输出项附本次投影成本）
 * @param knownLowerBound 已读投影的成本可作为下界；需排除折叠标记与祖先位升格缩短等情形
 */
function budgetError(limit: ViewLimit, knownLowerBound = false): CognitionError {
  const axes: (keyof Budget)[] = ['maxScans', 'maxNodes', 'maxBytes'];
  const exceeded = axes.filter((name) => limit[name] !== undefined).join('、');
  const minimum = knownLowerBound && limit.maxBytes !== undefined
    ? `已知 maxBytes 至少需要 ${limit.maxBytes} 字节（UTF-8），不代表整段范围已测完。` : '';
  return new CognitionError('rangeTooLarge', `读取超出 ${exceeded}。${minimum}请增加对应预算或缩小范围。`);
}

/** 一条尚未完全连回本页的原树父链；续读只保留已实际读到的行。 */
interface Connection { rows: NodeRow[]; next: string | null; seen: Set<string> }
/** 一条已经读出但还未成功投影的邻接项，不能在预算失败后丢失或跳过。 */
interface Pending { ref?: Ref; child?: NodeRow; landingId?: string; connection?: Connection }
/** 一个展开状态；游标只存遍历位置，不改变节点真实父关系。 */
interface Task {
  row: NodeRow; depth: Depth; hops: number; jump: boolean;
  phase: 'children' | 'out' | 'in'; after: string | null;
  connection?: Connection; pending?: Pending;
}
/** 已排入遍历的非支配范围，用来终止引用环并允许较强状态补读。 */
interface Coverage { depth: Depth; hops: number; jump: boolean }

/** 一次持续读取的状态；由 view 的有界游标注册表持有同一快照。 */
export interface Traversal {
  snapshot: ReadSnapshot;
  focusId: string;
  expand: Expand;
  expiresAt: number;
  base?: NodeRow[];
  initial?: Connection;
  started: boolean;
  tasks: Task[];
  coverage: Map<string, Coverage[]>;
  hits: Set<string>;
}

/** 仅用于在本次预算用尽时暂停；不越过公开错误边界。 */
class ScanLimit extends Error {}

/** 每页扫描表，先预留后发请求，不以多读再截断冒充扫描预算。 */
class Scans {
  used = 0;
  /**
   * 建立本页扫描表。
   * @param maximum 本页最多实际查找/邻接检查数
   */
  constructor(private readonly maximum: number) {}
  /** 为一次单项查找（包含空查）计费，无余额时不访问端口。 */
  take(): void { if (this.used >= this.maximum) throw new ScanLimit(); this.used++; }
}

/**
 * 把深度转成只用于比较的值，不向存储端口传无穷预算。
 * @param value 显式边数或 leaf
 */
function depthValue(value: Depth): number { return value === 'leaf' ? Infinity : value; }

/**
 * 判断已排入状态能否覆盖新状态；不同剩余深度/跳数的权衡不能错误合并。
 * @param left 已有或候选较强状态
 * @param right 待比较状态
 */
function dominates(left: Coverage, right: Coverage): boolean {
  return depthValue(left.depth) >= depthValue(right.depth)
    && (!right.jump || (left.jump && left.hops >= right.hops));
}

/**
 * 只为尚未覆盖的展开范围排入任务；连接祖先绝不会从这里自动起跳。
 * @param state 同一快照下的遍历
 * @param row 实际命中的轻行
 * @param depth 此轮剩余树深
 * @param hops 此路径剩余引用跳数
 * @param jump 此节点是否属于起跳范围
 */
function schedule(state: Traversal, row: NodeRow, depth: Depth, hops: number, jump: boolean): void {
  const candidate = { depth, hops: jump ? hops : 0, jump };
  const known = state.coverage.get(row.id) ?? [];
  if (known.some((range) => dominates(range, candidate))) return;
  state.coverage.set(row.id, [...known.filter((range) => !dominates(candidate, range)), candidate]);
  state.tasks.push({ row, ...candidate, phase: 'children', after: null });
}

/**
 * 创建尚未连接的路径；传入 seed 表示该行已由邻接读取计费。
 * @param nodeId 要连回本页的节点 ID
 * @param seed 已经读到的目标行，省略则按 ID 查找
 */
function connection(nodeId: string, seed?: NodeRow): Connection {
  return seed ? { rows: [seed], next: seed.parentId, seen: new Set([seed.id]) }
    : { rows: [], next: nodeId, seen: new Set() };
}

/**
 * 沿真实父 ID 向上查，直到本页已有祖先；未连好时只留在内部状态，不输出断树。
 * @param path 可跨页保留的局部路径
 * @param page 当前页，首次焦点路径允许省略
 * @param state 读快照和树根
 * @param scans 本页剩余扫描表
 */
async function connect(path: Connection, page: ViewPage | undefined, state: Traversal, scans: Scans): Promise<void> {
  while (path.next !== null && !page?.has(path.next)) {
    if (path.seen.has(path.next)) throw new CognitionError('storage', '原树父链出现循环。');
    scans.take();
    const nodeId = path.next;
    const row = await state.snapshot.readNodeRow(nodeId);
    if (!row) {
      if (path.rows.length === 0 && nodeId === state.focusId) throw new CognitionError('missing', '焦点判断不存在。');
      throw new CognitionError('storage', '引用端点或原树父链缺失。');
    }
    if (row.id !== nodeId) throw new CognitionError('storage', '存储返回了不匹配的节点 ID。');
    path.rows.push(row);
    path.seen.add(row.id);
    path.next = row.parentId;
  }
  if (path.next === null && path.rows[path.rows.length - 1]?.id !== state.snapshot.rootId) {
    throw new CognitionError('storage', '节点父链没有连到原树根。');
  }
}

/**
 * 生成单个位置的边界。
 * @param nodeId 停下的节点
 * @param axis 孩子或引用方向
 * @param kind 参数、查尽或预算边界
 */
function boundary(nodeId: string, axis: Boundary['axis'], kind: Boundary['kind']): Boundary {
  return { nodeId, axis, kind };
}

/**
 * 根据正在处理的阶段选择折叠轴；未输出的远端暂标在仍在页内的焦点位置。
 * @param state 未完成遍历
 * @param page 当前连通页
 */
function marker(state: Traversal, page: ViewPage): Boundary {
  const task = state.tasks[state.tasks.length - 1];
  return boundary(task && page.has(task.row.id) ? task.row.id : state.focusId,
    task?.phase === 'children' ? 'children' : 'refs', 'budget');
}

/**
 * 取已连接路径中累计属于命中的节点，避免跨页把命中降成仅连接。
 * @param state 累计命中状态
 * @param rows 本次连回的轻行
 * @param extra 本次新命中的端点
 */
function hits(state: Traversal, rows: NodeRow[], extra?: string): string[] {
  const result = rows.filter((row) => state.hits.has(row.id)).map((row) => row.id);
  if (extra !== undefined) result.push(extra);
  return result;
}

/**
 * 孩子阶段结束后选本次范围要求的第一个引用方向。
 * @param task 即将进入引用阶段的任务
 * @param expand 调用方显式方向
 */
function beginRefs(task: Task, expand: Expand): void {
  task.phase = expand.direction === 'in' ? 'in' : 'out';
  task.after = null;
}

/**
 * 初始化一次持续查询，不访问存储；焦点及父链在本页预算内读取。
 * @param snapshot 已打开的同版本快照
 * @param focusId 已解析的焦点
 * @param expand 显式展开范围
 * @param expiresAt 绝对到期时刻（毫秒），续读不无限延长
 */
export function createTraversal(snapshot: ReadSnapshot, focusId: string, expand: Expand, expiresAt: number): Traversal {
  return {
    snapshot, focusId, expand: { ...expand }, expiresAt, started: false,
    tasks: [], coverage: new Map(), hits: new Set([focusId]), initial: connection(focusId),
  };
}

/**
 * 读取一页有根、连通的视图；只有逻辑遍历确实推进才允许再发游标。
 * @param state 同一查询及快照的累计遍历
 * @param budget 本页独立预算，扫描按端口实际调用计费
 * @param onLimit exact 超限即失败；fold 保留未完成位置
 * @param cursor 已由注册表分配、用于本页响应精确计费的短游标
 * @param omitRefScope 本查询零引用跳数且不输出逐节点 refs/scope；不进入仅为标记范围而存在的引用阶段
 * @param wireCost 仅用于输出预算的可选模型文本度量
 * @throws CognitionError 无法容纳焦点/父链、无法正向推进或 exact 超限时 rangeTooLarge
 */
export async function readViewPage(
  state: Traversal, budget: Budget, onLimit: 'fold' | 'exact', cursor: string, omitRefScope: boolean, wireCost?: ViewWireCost,
): Promise<TreeView> {
  const scans = new Scans(budget.maxScans);
  const page = new ViewPage(state.snapshot.rootId, state.focusId, state.snapshot.stamp, budget, cursor, wireCost);
  let progress = state.started ? 0 : 1;
  if (!state.base) {
    try { await connect(state.initial!, undefined, state, scans); }
    catch (error) { if (error instanceof ScanLimit) throw budgetError({ maxScans: true }); throw error; }
    state.base = state.initial!.rows;
    state.initial = undefined;
    schedule(state, state.base[0], state.expand.subtreeDepth, state.expand.jumpHops, true);
  }
  // 无跳转的原生 JSON 不会因升格或合用编码而缩短；紧凑候选可能重分共享项，不宣称全查询字节下界。
  const knownByteLowerBound = state.expand.jumpHops === 0 && wireCost === undefined;
  const baseLimit = page.apply({ rows: state.base, hits: hits(state, state.base) }, null);
  if (baseLimit) throw budgetError(baseLimit, knownByteLowerBound);
  state.started = true;
  let lastMarker = boundary(state.focusId, 'children', 'budget');
  let stopped: ViewLimit | undefined;
  /**
   * 试投影整条工作项；失败原因用于解释停止处，不让诊断引发额外扫描。
   * @param proposal 拟加入的内容
   * @param mark 需随候选页预留的预算标记
   */
  const tryProject = (proposal: Projection, mark: Boundary | null): boolean => {
    stopped = page.apply(proposal, mark);
    return stopped === undefined;
  };
  /** 求候选页的预算标记；已知完成时不预留游标。@param task 当前工作项。@param final 成功后是否结束查询。 */
  const projectionMarker = (task: Task, final: boolean): Boundary | null =>
    onLimit === 'exact' || final ? null : boundary(task.row.id, task.phase === 'children' ? 'children' : 'refs', 'budget');

  try {
    while (state.tasks.length > 0) {
      if (Date.now() >= state.expiresAt) throw new CognitionError('viewExpired', '读取视图已到期，请从折叠位置重新读取。');
      const task = state.tasks[state.tasks.length - 1];
      if (!page.has(task.row.id)) {
        task.connection ??= connection(task.row.id, task.row);
        await connect(task.connection, page, state, scans);
        if (!tryProject({ rows: task.connection.rows, hits: hits(state, task.connection.rows) }, projectionMarker(task, false))) break;
        task.connection = undefined;
      }
      lastMarker = marker(state, page);
      if (task.phase === 'children') {
        // 两个零范围可一次结束，避免仅因预留不会实际返回的游标而拒绝完整小视图。
        if (task.depth === 0 && (!task.jump || task.hops === 0)) {
          const final = state.tasks.length === 1;
          const boundaries = [boundary(task.row.id, 'children', 'scope')];
          if (!omitRefScope) boundaries.push(boundary(task.row.id, 'refs', 'scope'));
          if (!tryProject({ boundaries }, projectionMarker(task, final))) break;
          state.tasks.pop(); progress++; continue;
        }
        if (task.depth === 0) {
          if (!tryProject({ boundaries: [boundary(task.row.id, 'children', 'scope')] }, projectionMarker(task, false))) break;
          beginRefs(task, state.expand); progress++; continue;
        }
        if (!task.pending) {
          scans.take();
          const rows = await state.snapshot.listChildren(task.row.id, task.after, 1);
          if (rows.length > 1) throw new CognitionError('storage', '孩子索引超出请求的单行额度。');
          if (rows.length === 0) {
            const final = omitRefScope && state.tasks.length === 1;
            if (!tryProject({ boundaries: [boundary(task.row.id, 'children', 'exhausted')] }, projectionMarker(task, final))) break;
            // 零跳数下没有引用工作；预算截断也不该落在从未查询的 refs 轴。
            if (omitRefScope) state.tasks.pop();
            else beginRefs(task, state.expand);
            progress++; continue;
          }
          if (rows[0].parentId !== task.row.id || (task.after !== null && compareIds(rows[0].id, task.after) <= 0)) {
            throw new CognitionError('storage', '孩子索引没有按真实父节点与稳定 ID 前进。');
          }
          task.pending = { child: rows[0], landingId: rows[0].id, connection: connection(rows[0].id, rows[0]) };
        }
      } else {
        if (!task.jump || task.hops === 0) {
          const final = state.tasks.length === 1;
          if (!tryProject({ boundaries: [boundary(task.row.id, 'refs', 'scope')] }, projectionMarker(task, final))) break;
          state.tasks.pop(); progress++; continue;
        }
        if (!task.pending) {
          scans.take();
          const refs = task.phase === 'out'
            ? await state.snapshot.listRefsFrom(task.row.id, task.after, 1)
            : await state.snapshot.listRefsTo(task.row.id, task.after, 1);
          if (refs.length > 1) throw new CognitionError('storage', '引用索引超出请求的单行额度。');
          if (refs.length === 0) {
            if (task.phase === 'out' && state.expand.direction === 'both') {
              task.phase = 'in'; task.after = null; progress++; continue;
            }
            const final = state.tasks.length === 1;
            if (!tryProject({ boundaries: [boundary(task.row.id, 'refs', 'exhausted')] }, projectionMarker(task, final))) break;
            state.tasks.pop(); progress++; continue;
          }
          const ref = refs[0];
          if ((task.after !== null && compareIds(ref.id, task.after) <= 0)
            || (task.phase === 'out' && ref.from !== task.row.id)
            || (task.phase === 'in' && (!('nodeId' in ref.target) || ref.target.nodeId !== task.row.id))) {
            throw new CognitionError('storage', '引用索引没有按原方向和稳定 ID 前进。');
          }
          const landingId = task.phase === 'out'
            ? ('nodeId' in ref.target ? ref.target.nodeId : undefined) : ref.from;
          task.pending = { ref, landingId, ...(landingId !== undefined ? { connection: connection(landingId) } : {}) };
        }
      }
      const pending = task.pending!;
      if (pending.connection) await connect(pending.connection, page, state, scans);
      const rows = pending.connection?.rows ?? [];
      if (!tryProject({ rows, hits: hits(state, rows, pending.landingId), ref: pending.ref }, projectionMarker(task, false))) break;
      task.after = pending.child?.id ?? pending.ref!.id;
      task.pending = undefined;
      progress++;
      if (pending.landingId !== undefined) {
        state.hits.add(pending.landingId);
        const row = page.row(pending.landingId)!;
        if (pending.child) {
          schedule(state, row, task.depth === 'leaf' ? 'leaf' : task.depth - 1, task.hops, state.expand.jumpFrom === 'expanded');
        } else {
          schedule(state, row, state.expand.afterJumpDepth, task.hops - 1, true);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof ScanLimit)) throw error;
    stopped = { maxScans: true };
  }
  if (state.tasks.length === 0) return page.finish(null);
  if (!stopped) throw new Error('未完成的视图缺少停止原因。');
  if (onLimit === 'exact' || progress === 0) throw budgetError(stopped, onLimit === 'exact' && knownByteLowerBound);
  const pendingMarker = marker(state, page);
  if (!page.overBudget(pendingMarker)) return page.finish(pendingMarker);
  const fallbackLimit = page.overBudget(lastMarker);
  if (!fallbackLimit) return page.finish(lastMarker);
  // 链路可以连通，但两种真实的续读标记都放不下；这不是完整结果的最低字节数。
  throw budgetError({ ...stopped, ...fallbackLimit });
}
