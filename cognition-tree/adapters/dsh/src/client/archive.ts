/**
 * 归档与恢复（客户端）：同源 POST 到 ARCHIVE_PATH，只带可信 sessionId。
 *
 * 职责：实现共享 UI 的 ArchiveAccess 端口。
 * - list：省略 treeId 只列整棵已归档的树；给 treeId 只列该活动树的显式分支归档。
 * - archive / restore：没有 nodeId 时作用整棵树，有 nodeId 时只影响该判断及其子树。
 * 请求体是 `{sessionId, ...action}`，响应沿用插件标准信封 `{ok, value}` / `{ok, error}`；
 * 修改成功时 value 为 null。
 *
 * 状态归属：服务端是归档事实的唯一来源；这里不缓存列表、不猜可见性。
 * 边界：写入只尝试一次，不自动重试；不传路径、不从浏览器读旧归档。独立浏览器入口不创建本端口。
 */
import type { ArchiveAccess, ArchiveItem as UiArchiveItem } from '@cognition-tree/ui/types/ports';
import { ARCHIVE_PATH, type ArchiveAction } from '../types/wire';
import { normalizeId } from './session';
import { wireError } from './transport';

/** 归档客户端的装配参数。 */
export interface ArchiveClientOptions {
  /** 宿主当前会话；面板在空值时根本不创建归档端口。 */
  sessionId: string;
  /** 测试注入的 fetch；缺省用全局同源 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 已解析的服务端信封；坏 JSON 归为 unknown，不冒充空列表。 */
type Envelope =
  | { ok: true; value: unknown }
  | { ok: false; code: string; message: string };

/**
 * 解析标准信封。
 * @param text 响应正文
 * @returns 成功值或可显示的业务错误
 */
function parseEnvelope(text: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw wireError('unknown', '归档服务返回了无法解析的结果。');
  }
  if (!raw || typeof raw !== 'object') throw wireError('unknown', '归档服务返回了无法识别的结果。');
  const body = raw as Record<string, unknown>;
  if (body.ok === true) return { ok: true, value: body.value };
  if (body.ok === false) {
    const failure = body.error as Record<string, unknown> | undefined;
    const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'unknown';
    const message =
      typeof failure?.message === 'string' && failure.message !== '' ? failure.message : '归档操作失败。';
    return { ok: false, code, message };
  }
  throw wireError('unknown', '归档服务返回了无法识别的结果。');
}

/**
 * 规范化列表里的一个归档项，并核对它属于哪一类列表。
 * 整树列表里的条目不能带 nodeId；分支列表里的条目必须有非空 nodeId 且属于所查的树。
 * 形状不符的项直接丢弃，避免把整树条目当成分支恢复（或反过来）。
 * @param value 服务端列表项
 * @param listTreeId 本次查询的树；省略表示整树列表
 * @returns 归档项；无法辨认或超出本次列表范围时为 null
 */
function readItem(value: unknown, listTreeId?: string): UiArchiveItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const treeId = item.treeId;
  if (typeof treeId !== 'string' || !treeId.trim()) return null;
  const title = typeof item.title === 'string' ? item.title : '';
  if (listTreeId === undefined) {
    // 整树列表：带 nodeId 的条目属于分支范围，不能出现在这里。
    if (item.nodeId !== undefined) return null;
    return { treeId, title };
  }
  const nodeId = item.nodeId;
  if (typeof nodeId !== 'string' || !nodeId.trim() || treeId !== listTreeId) return null;
  return { treeId, nodeId, title };
}

/**
 * 创建归档端口。
 * @param options 当前受信会话与测试注入
 * @returns 列表、归档与恢复都走同一路由的端口实现
 * @throws WireError 没有会话时拒绝创建
 */
export function createArchiveAccess(options: ArchiveClientOptions): ArchiveAccess {
  const sessionId = normalizeId(options.sessionId);
  if (!sessionId) throw wireError('invalid', '没有当前会话，无法归档。');
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  /**
   * 发一次归档请求并解析信封。
   * @param action 列表或修改动作
   * @param failure 网络/响应丢失时给人看的说明
   * @returns 成功值（列表为数组，修改为 null）
   */
  const post = async (action: ArchiveAction, failure: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await doFetch(ARCHIVE_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...action }),
      });
    } catch (error) {
      // 结果未知：请求可能已到服务端但响应丢失；不重试，让调用方重新读取核对。
      throw wireError('unknown', failure);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw wireError('unknown', failure);
    }
    const envelope = parseEnvelope(text);
    if (!envelope.ok) throw wireError(envelope.code, envelope.message);
    if (!response.ok) throw wireError('unknown', '归档响应状态与正文不一致，请重新读取核对。');
    return envelope.value;
  };

  return {
    async list(treeId) {
      const value = await post(treeId === undefined ? { action: 'list' } : { action: 'list', treeId }, '无法连接归档服务，请稍后重试。');
      if (!Array.isArray(value)) throw wireError('unknown', '归档列表返回了无法识别的结果。');
      const items: UiArchiveItem[] = [];
      for (const entry of value) {
        const item = readItem(entry, treeId);
        if (item) items.push(item);
      }
      return items;
    },

    async archive(target) {
      // 空字符串是调用方给错，不能悄悄退化成整树归档；服务端会按无效 ID 拒绝。
      const action: ArchiveAction = target.nodeId !== undefined
        ? { action: 'archive', treeId: target.treeId, nodeId: target.nodeId }
        : { action: 'archive', treeId: target.treeId };
      const value = await post(action, '无法连接归档服务；归档结果未知，请重新读取核对。');
      if (value !== null) throw wireError('unknown', '归档响应与正文不一致，请重新读取核对。');
    },

    async restore(target) {
      const action: ArchiveAction = target.nodeId !== undefined
        ? { action: 'restore', treeId: target.treeId, nodeId: target.nodeId }
        : { action: 'restore', treeId: target.treeId };
      const value = await post(action, '无法连接归档服务；恢复结果未知，请重新读取核对。');
      if (value !== null) throw wireError('unknown', '恢复响应与正文不一致，请重新读取核对。');
    },
  };
}
