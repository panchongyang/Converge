/**
 * 视图持续读取的生命周期：同一游标始终绑定同一查询和 ReadSnapshot，不重新打开新版本拼页。
 * 每个 createQueries 实例最多保留 8 个活动/闲置视图，绝对寿命 60 秒，完成和错误即时 close。
 * 内核只用 ES 标准库；到期采用所有查询入口的惰性清理，无宿主计时器。无人再调用时不主动唤醒；
 * 后续调用会先关闭过期快照，容量上限也会驱逐最早闲置快照。游标为短、不含正文的单次令牌。
 */
import { CognitionError } from '../types/index';
import type { Budget, Expand, TreeStore, TreeView } from '../types/index';
import { createTraversal, readViewPage } from './traversal';
import type { Traversal } from './traversal';
import { validateView, viewKey } from './validation';
import type { Focus } from './validation';
import type { ViewWireCost } from './view-page';

/** 固定实例上限与绝对 TTL；不以续读不断延长事务生命周期。 */
const MAX_VIEWS = 8;
const VIEW_TTL_MS = 60_000;
// 时间与随机后缀只区分进程代际（不是权限令牌）。线程重启、注册表重建后，旧游标不能误命中新快照。
// 命名在查询层完成：预算核算的 token 就是实际返回的 token，适配器无需在响应外再拼前缀。
const generation = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
let factorySequence = 0;
/** 注册表只保存尚未完成的真实遍历状态，不把查询结果编码进游标。 */
interface Entry { key: string; state: Traversal }

/** 视图读取器内部接口，index 还会在其它短查询入口调用 cleanup。 */
export interface ViewReader {
  cleanup(): Promise<void>;
  read(
    treeId: string, focus: Focus, expand: Expand, budget: Budget, onLimit: 'fold' | 'exact',
    cursor?: string, aiProjection?: boolean, includeDetails?: boolean,
  ): Promise<TreeView>;
}

/**
 * 装配一个独立、有界的视图游标注册表；不修改存储，也不共享另一个调用方的游标。
 * @param store 注入的单树存储端口
 * @param aiViewCost AI 输出的可选字节度量；人侧不使用
 */
export function createViewReader(store: TreeStore, aiViewCost?: ViewWireCost): ViewReader {
  const instance = `${generation}-${(++factorySequence).toString(36)}`;
  let sequence = 0;
  let active = 0;
  let closing = 0;
  const retained = new Map<string, Entry>();

  /**
   * 先从注册表摘除再关闭，防止并行入口重复释放同一快照。
   * @param token 即将失效的令牌
   * @param entry 令牌所持状态
   */
  async function release(token: string, entry: Entry): Promise<void> {
    retained.delete(token);
    closing++;
    try { await entry.state.snapshot.close(); }
    finally { closing--; }
  }

  /** 关闭到期闲置快照；由全部公开查询入口调用，不分配宿主定时资源。 */
  async function cleanup(): Promise<void> {
    const now = Date.now();
    for (const [token, entry] of retained) {
      if (entry.state.expiresAt <= now) await release(token, entry);
    }
  }

  /**
   * 取一页视图，游标仅可成功消费一次；并行消费不会重复推进同一个快照。
   * @param treeId 所选树 ID
   * @param focus 节点 ID 或显式根
   * @param expand 必传的展开范围，续读必须一致
   * @param budget 本页独立预算，可与上页不同
   * @param onLimit 超限策略，续读必须一致
   * @param cursor 上页返回的令牌；首次省略
   * @param aiProjection 可信 AI 入口零跳数时省略 refs/scope，轻量页使用注入的模型度量
   * @param includeDetails 是否随页返回完整详情；省略等价于 false，续读须保持一致
   */
  async function read(
    treeId: string, focus: Focus, expand: Expand, budget: Budget, onLimit: 'fold' | 'exact', cursor?: string,
    aiProjection = false, includeDetails = false,
  ): Promise<TreeView> {
    validateView(treeId, focus, expand, budget, onLimit, cursor);
    if (typeof includeDetails !== 'boolean') throw new CognitionError('invalid', 'includeDetails 必须是布尔值。');
    // 在第一个异步让出点之前捕获已校验参数，调用方后续改对象不能放宽预算或改变范围。
    const requestExpand = { ...expand };
    const requestBudget = { ...budget };
    const omitRefScope = aiProjection && requestExpand.jumpHops === 0;
    const wireCost = aiProjection && !includeDetails ? aiViewCost : undefined;
    const key = viewKey(treeId, focus, requestExpand, onLimit, omitRefScope, wireCost !== undefined, includeDetails);
    const focusId = typeof focus === 'string' ? focus : undefined;
    await cleanup();
    let entry: Entry | undefined;
    if (cursor !== undefined) {
      entry = retained.get(cursor);
      if (!entry) throw new CognitionError('viewExpired', '续读游标已到期、已被消费或已释放，请重新读取。');
      if (entry.key !== key) throw new CognitionError('invalid', '续读须保持同一棵树、焦点、展开范围、超限策略和视图格式。');
      retained.delete(cursor);
    }
    // 先预留活动位再等待关闭/打开，关闭中的旧快照也占位，避免并行驱逐突破上限。
    active++;
    let attemptedClose = false;
    try {
      if (!entry) {
        while (retained.size + active + closing > MAX_VIEWS) {
          const oldest = retained.entries().next().value as [string, Entry] | undefined;
          if (!oldest) throw new CognitionError('rangeTooLarge', '同时读取的视图过多，请等待当前读取完成。');
          await release(oldest[0], oldest[1]);
        }
        const snapshot = await store.openRead(treeId);
        entry = {
          key,
          state: createTraversal(snapshot, focusId ?? snapshot.rootId, requestExpand, Date.now() + VIEW_TTL_MS, includeDetails),
        };
      }
      const token = `q${instance}.${(++sequence).toString(36)}`;
      const result = await readViewPage(entry.state, requestBudget, onLimit, token, omitRefScope, wireCost);
      if (result.complete) { attemptedClose = true; await entry.state.snapshot.close(); }
      else retained.set(token, entry);
      return result;
    } catch (error) {
      // 失败的遍历不能继续；保留原错误，不让清理失败掩盖 missing/rangeTooLarge 等结果。
      if (entry && !attemptedClose) { try { await entry.state.snapshot.close(); } catch { /* 原错误优先。 */ } }
      throw error;
    } finally {
      active--;
    }
  }
  return { cleanup, read };
}
