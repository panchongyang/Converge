/**
 * 查询层唯一公开入口。职责：在一致读中投影连通树、节点详情、历史和未确认分页；不写日志。
 * 状态归属：每个 createQueries 实例持有有界、短期的读游标；树事实和索引仍属于注入的 TreeStore。
 * 外部依赖仅为 types / utils 与 ES 标准库；models/catalog 调此入口，宿主不复制遍历规则。
 * 契约依据：docs/design/kernel-interfaces.md §3.1、§3.2；具体计费与生命周期分别见 view-page、view。
 */
import type { Budget, Expand, NodeDetail, Page, PendingPage, Revision, TreeStore, TreeView } from '../types/index';
import * as records from './records';
import type { HistoryInput, UnconfirmedInput } from './records';
import { createViewReader } from './view';
import type { Focus } from './validation';
import type { ViewWireCost } from './view-page';

export type { Focus } from './validation';
export type { ViewWireCost } from './view-page';
export type { HistoryInput, UnconfirmedInput } from './records';

/** 公开只读能力；所有目标、范围、筛选与页大小都由调用方显式给出。 */
export interface Queries {
  /**
   * 按独立预算读取局部树；每页连回原根，续读不混版本。
   * @param treeId 所选树 ID
   * @param focus 节点 ID，或显式的 {root: true}
   * @param expand 初始深度、跳数、方向、起跳范围与跳后深度
   * @param budget 本页实际扫描、节点与 UTF-8 响应字节上限
   * @param onLimit fold 超限返回可续读部分，exact 超限报 rangeTooLarge
   * @param cursor 首次省略；续读原样传回，保持同一查询
   * @param aiProjection 可信内部调用为 true 时使用 AI 投影：零跳数不重复 refs/scope，并以已注入的模型度量计费
   */
  readView(treeId: string, focus: Focus, expand: Expand, budget: Budget, onLimit: 'fold' | 'exact', cursor?: string, aiProjection?: boolean): Promise<TreeView>;
  /**
   * 取节点全文和当前形成记录；不存在报 missing。
   * @param treeId 所选树 ID
   * @param nodeId 目标判断稳定 ID
   */
  readNode(treeId: string, nodeId: string): Promise<NodeDetail>;
  /**
   * 按索引从新到旧取一页历史，不扫描全表。
   * @param treeId 所选树 ID
   * @param input 可选节点过滤、必传页大小、可选末项修订 ID
   */
  readHistory(treeId: string, input: HistoryInput): Promise<Page<Revision>>;
  /**
   * 按未确认索引取一页直接可供确认的目标，不全量计数。
   * @param treeId 所选树 ID
   * @param input 必传执行者子集、页大小和可选末项确认目标
   */
  readUnconfirmed(treeId: string, input: UnconfirmedInput): Promise<PendingPage>;
}

/**
 * 装配公开查询；实例应在所属工作区客户端生命周期内复用，游标不能跨实例转移。
 * @param store 由适配器绑定工作区、提供一致读和稳定索引的存储端口
 * @param aiViewCost 可选的 AI 投影精确字节度量；其他投影按 JSON 计费
 * @returns 不包含写入、确认或宿主访问能力的查询对象
 */
export function createQueries(store: TreeStore, aiViewCost?: ViewWireCost): Queries {
  const views = createViewReader(store, aiViewCost);
  return {
    readView: views.read,
    /**
     * 点查前一并回收过期视图。
     * @param treeId 所选树 ID
     * @param nodeId 目标判断 ID
     */
    async readNode(treeId, nodeId) {
      await views.cleanup();
      return records.readNode(store, treeId, nodeId);
    },
    /**
     * 历史分页前一并回收过期视图。
     * @param treeId 所选树 ID
     * @param input 页大小、可选节点和末项
     */
    async readHistory(treeId, input) {
      await views.cleanup();
      return records.readHistory(store, treeId, input);
    },
    /**
     * 未确认分页前一并回收过期视图。
     * @param treeId 所选树 ID
     * @param input 执行者子集、页大小和末项
     */
    async readUnconfirmed(treeId, input) {
      await views.cleanup();
      return records.readUnconfirmed(store, treeId, input);
    },
  };
}
