/**
 * 一页视图的连通投影与精确 UTF-8 计费。只持有本页行；遍历状态在 traversal，快照在 view。
 * 缺省按最终 JSON（含游标、引用、边界和标点）增量计费；宿主可为有界的模型投影注入精确字节度量。
 */
import type { Boundary, Budget, NodeRow, Ref, TreeView, ViewNode } from '../types/index';
import { utf8ByteLength } from '../utils/index';

/** 一次原子投影：连回根的轻行、实际命中的节点、引用和已确定的边界。 */
export interface Projection {
  rows?: NodeRow[];
  hits?: string[];
  ref?: Ref;
  boundaries?: Boundary[];
}

/** 仅含失败的输出维度，值是该次候选投影的实际成本（不一定是整次查询的下界）。 */
export type OutputLimit = Partial<Pick<Budget, 'maxNodes' | 'maxBytes'>>;

/** 宿主注入的模型输出度量，必须纯且确定；它只影响回包计费，不解释树事实。 */
export interface ViewWireCost {
  /** 在构造候选页之前筛去宽页；false 表示按既有 JSON 成本计费。 */
  canMeasure(nodeCount: number, refCount: number): boolean;
  /** 返回同一候选页最终文本的 UTF-8 字节数；不能紧凑表示时返回 undefined，沿用 JSON。 */
  measure(view: TreeView): number | undefined;
}

/**
 * JSON 编码后的 UTF-8 大小；转义后的孤立代理项也按实际响应计费。
 * @param value 待写入响应的 JSON 值
 */
function bytes(value: unknown): number { return utf8ByteLength(JSON.stringify(value)); }

/**
 * 生成节点某个轴的唯一键，不依赖 ID 中是否含分隔符。
 * @param boundary 要索引的边界
 */
function boundaryKey(boundary: Boundary): string { return JSON.stringify([boundary.nodeId, boundary.axis]); }

/** 本页输出构造器；只允许整条连接路径原子加入，避免返回半条父链。 */
export class ViewPage {
  private readonly nodes = new Map<string, ViewNode>();
  private readonly refs = new Map<string, Ref>();
  private readonly boundaries = new Map<string, Boundary>();
  private nodeBytes = 0;
  private refBytes = 0;
  private boundaryBytes = 0;
  private readonly fixedBytes: number;

  /**
   * 建立空页；预算参数由公开入口校验。
   * @param rootId 原树根
   * @param focusId 显式焦点解析后的节点 ID
   * @param stamp 快照提交版本
   * @param budget 只约束本页实际返回值
   * @param cursor 本页若折叠将返回的短游标，预先确定以精确计费
   * @param wireCost 显式注入的模型文本度量；省略时保持内核的 JSON 预算
   */
  constructor(
    private readonly rootId: string,
    private readonly focusId: string,
    private readonly stamp: number,
    private readonly budget: Budget,
    private readonly cursor: string,
    private readonly wireCost?: ViewWireCost,
  ) {
    this.fixedBytes = bytes({ rootId, focusId, nodes: [], refs: [], boundaries: [], complete: true, stamp });
  }

  /**
   * 判断本页是否已含某节点，连接路径遇到它即可停止向上查。
   * @param nodeId 节点 ID
   */
  has(nodeId: string): boolean { return this.nodes.has(nodeId); }

  /**
   * 取已连通的本页轻行，供引用落在已有节点时复用，不重复查存储。
   * @param nodeId 节点 ID
   */
  row(nodeId: string): NodeRow | undefined { return this.nodes.get(nodeId); }

  /**
   * 测算含折叠标记和游标的最终输出。只对宿主声明有界的模型页构造候选；其余使用常数开销的 JSON 计费。
   * @param marker 未完成位置；null 表示查询已经累计读完
   */
  private size(marker: Boundary | null): number {
    if (this.wireCost?.canMeasure(this.nodes.size, this.refs.size)) {
      const actual = this.measuredBytes(this.response(marker));
      if (actual !== undefined) return actual;
    }
    let count = this.boundaries.size;
    let boundaryBytes = this.boundaryBytes;
    if (marker) {
      const old = this.boundaries.get(boundaryKey(marker));
      boundaryBytes += bytes(marker) - (old ? bytes(old) : 0);
      if (!old) count++;
    }
    return this.fixedBytes + this.nodeBytes + Math.max(0, this.nodes.size - 1)
      + this.refBytes + Math.max(0, this.refs.size - 1)
      + boundaryBytes + Math.max(0, count - 1)
      // false 比 true 多一字节；cursor 属性含逗号、冒号和自身 JSON 转义。
      + (marker ? 1 + utf8ByteLength(',"cursor":') + bytes(this.cursor) : 0);
  }

  /**
   * 试加入一次完整投影；超限则还原本页，不让断开的引用或半条连接路径泄露。
   * @param projection 候选节点、引用和边界
   * @param marker 成功后若还有工作，应标出的预算位置；最终结果传 null
   * @returns 失败时给出超限维度和还原前的成本；成功时返回 undefined。不消耗存储扫描预算
   */
  apply(projection: Projection, marker: Boundary | null): OutputLimit | undefined {
    const oldNodes = new Map<string, ViewNode | undefined>();
    const oldBounds = new Map<string, Boundary | undefined>();
    const oldSizes = [this.nodeBytes, this.refBytes, this.boundaryBytes];
    const hits = new Set(projection.hits ?? []);
    const rows = projection.rows ?? [];
    for (const row of rows) {
      if (!oldNodes.has(row.id)) oldNodes.set(row.id, this.nodes.get(row.id));
      const old = this.nodes.get(row.id);
      const node: ViewNode = { ...row, role: old?.role === 'hit' || hits.has(row.id) ? 'hit' : 'link' };
      this.nodeBytes += bytes(node) - (old ? bytes(old) : 0);
      this.nodes.set(row.id, node);
    }
    for (const nodeId of hits) {
      const node = this.nodes.get(nodeId);
      if (node && node.role !== 'hit') {
        if (!oldNodes.has(nodeId)) oldNodes.set(nodeId, node);
        const hit: ViewNode = { ...node, role: 'hit' };
        this.nodeBytes += bytes(hit) - bytes(node);
        this.nodes.set(nodeId, hit);
      }
    }
    const oldRef = projection.ref ? this.refs.get(projection.ref.id) : undefined;
    if (projection.ref && !oldRef) {
      this.refs.set(projection.ref.id, projection.ref);
      this.refBytes += bytes(projection.ref);
    }
    for (const boundary of projection.boundaries ?? []) {
      const key = boundaryKey(boundary);
      const old = this.boundaries.get(key);
      if (!oldBounds.has(key)) oldBounds.set(key, old);
      // 重叠展开中，真正查尽覆盖较早的零深度/零跳数 scope；反过来不降级。
      if (old?.kind === 'exhausted' && boundary.kind === 'scope') continue;
      this.boundaries.set(key, boundary);
      this.boundaryBytes += bytes(boundary) - (old ? bytes(old) : 0);
    }
    const limit = this.overBudget(marker);
    if (!limit) return undefined;
    for (const [key, old] of oldNodes) { if (old) this.nodes.set(key, old); else this.nodes.delete(key); }
    for (const [key, old] of oldBounds) { if (old) this.boundaries.set(key, old); else this.boundaries.delete(key); }
    if (projection.ref && !oldRef) this.refs.delete(projection.ref.id);
    [this.nodeBytes, this.refBytes, this.boundaryBytes] = oldSizes;
    return limit;
  }

  /**
   * 核对当前页能否容下确切折叠标记，记录实际越过的上限；不访问存储。
   * @param marker 未完成位置，完整结果为 null
   */
  overBudget(marker: Boundary | null): OutputLimit | undefined {
    const nodes = this.nodes.size;
    const byteCount = this.size(marker);
    if (nodes <= this.budget.maxNodes && byteCount <= this.budget.maxBytes) return undefined;
    return {
      ...(nodes > this.budget.maxNodes ? { maxNodes: nodes } : {}),
      ...(byteCount > this.budget.maxBytes ? { maxBytes: byteCount } : {}),
    };
  }

  /** 按候选形状组装一页，供注入度量和最终输出共用。@param marker 预算边界；完成时为 null。 */
  private response(marker: Boundary | null): TreeView {
    const boundaries = new Map(this.boundaries);
    if (marker) boundaries.set(boundaryKey(marker), marker);
    return {
      rootId: this.rootId, focusId: this.focusId, nodes: [...this.nodes.values()],
      refs: [...this.refs.values()], boundaries: [...boundaries.values()], complete: marker === null, stamp: this.stamp,
      ...(marker ? { cursor: this.cursor } : {}),
    };
  }

  /** 校验可信适配器返回的度量单位和界限。@param view 已含候选折叠标记和游标的页。 */
  private measuredBytes(view: TreeView): number | undefined {
    const actual = this.wireCost?.measure(view);
    if (actual !== undefined && (!Number.isSafeInteger(actual) || actual < 0)) throw new Error('模型视图度量须为非负安全字节数。');
    return actual;
  }

  /**
   * 构造最终响应，并核对相同表示仍在字节预算内。
   * @param marker 预算边界；null 表示累计完成，省略游标
   */
  finish(marker: Boundary | null): TreeView {
    const view = this.response(marker);
    const wire = JSON.stringify(view);
    const actual = this.wireCost?.canMeasure(this.nodes.size, this.refs.size) ? this.measuredBytes(view) : undefined;
    if ((actual ?? utf8ByteLength(wire)) > this.budget.maxBytes) throw new Error('视图响应计费与实际编码不一致。');
    // 返回值不得与保留中的任务/焦点父链共享对象，否则调用方改一页会篡改同 stamp 的下一页。
    return JSON.parse(wire) as TreeView;
  }
}
