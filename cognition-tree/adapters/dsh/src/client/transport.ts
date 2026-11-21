/**
 * DSH 客户端到插件服务端的唯一 HTTP/SSE 通道。
 *
 * 职责：实现共享 UI 的 CognitionClient 端口：
 * - call：POST {sessionId, op, input}，服务端把会话解析成可信工作区；客户端从不传路径。
 * - watch：同源 EventSource；ready 首帧表示连接建立，change 表示后台提交成功。
 *
 * 状态归属：树事实只在服务端；这里不缓存节点、不猜提交结果。
 * 写入只尝试一次，不自动重试（避免同一意图重复提交）；失败由 UI 按 code 显示。
 * 订阅：首次建连及断线期间的通知均不回放。每次 ready 以一次空修订的刷新信号触发
 * UI 重新读取，而不是假定初始读与建立监听之间没有变更。
 *
 * 边界：只接受宿主给出的 sessionId；空值直接拒绝，不退化成默认工作区或浏览器数据。
 */
import type { OpName, OpOutput } from '@cognition-tree/kernel/catalog/contracts';
import type { CognitionClient, TreeChange } from '@cognition-tree/ui/types/ports';
import { CALL_PATH, WATCH_PATH, type CallResult, type ChangeNotice } from '../types/wire';
import { normalizeId } from './session';

/** 调用失败时抛出的业务错误；code 与内核 ErrorCode 同名，UI 按 code 呈现。 */
export interface WireError extends Error {
  /** missing / invalid / storage / rangeTooLarge / viewExpired / unknown。 */
  code: string;
}

/** 创建一个带 code 的错误，供 UI 的 toUiError 识别。 */
export function wireError(code: string, message: string): WireError {
  const error = new Error(message) as WireError;
  error.name = 'CognitionWireError';
  error.code = code;
  return error;
}

/** 可替换的 EventSource 构造，测试注入假实现；生产用浏览器同源 EventSource。 */
export type EventSourceFactory = (url: string) => EventSource;

/** 客户端装配参数。 */
export interface ClientOptions {
  /** 宿主当前会话；调用前必须已确认，面板在空值时根本不创建客户端。 */
  sessionId: string;
  /** 测试注入的 fetch；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入的 EventSource 工厂；缺省用同源 EventSource。 */
  eventSource?: EventSourceFactory;
}

/** 读取响应体里的 CallResult；坏 JSON 视为未知失败，不冒充成功。 */
function parseCallResult(text: string): CallResult {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object') return value as CallResult;
  } catch (error) {
    // 落到下面的显式失败：网络/网关返回了非插件协议内容。
  }
  return { ok: false, error: { code: 'unknown', message: '认知树服务返回了无法解析的结果。' } };
}

/**
 * 组装调用结果。
 * @param result 服务端信封
 * @param op 用于错误提示的操作名
 * @returns 成功输出
 * @throws WireError 服务端明确失败或信封形状不符
 */
function unwrap<K extends OpName>(result: CallResult, op: K): OpOutput[K] {
  if (result && result.ok === true && Object.hasOwn(result, 'value')) return result.value as OpOutput[K];
  const failure = result && result.ok === false ? result.error : null;
  const code = failure && typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'unknown';
  const message = failure && typeof failure.message === 'string' && failure.message !== ''
    ? failure.message
    : `认知树操作 ${op} 失败。`;
  throw wireError(code, message);
}

/**
 * 创建人侧 CognitionClient。
 * @param options 当前受信会话与测试注入；路由固定同源
 * @returns 只读与写意图都走同一路由的端口实现
 */
export function createCognitionClient(options: ClientOptions): CognitionClient {
  const sessionId = normalizeId(options.sessionId);
  if (!sessionId) throw wireError('invalid', '没有当前会话，无法连接认知树。');
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const makeEvents = options.eventSource ?? ((url: string) => new EventSource(url, { withCredentials: true }));

  return {
    async call(op, input) {
      let response: Response;
      try {
        response = await doFetch(CALL_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, op, input }),
        });
      } catch (error) {
        // 结果未知：可能是请求已到服务端但响应丢失。不重试，交给 UI 重新读取核对。
        throw wireError('unknown', '无法连接认知树服务；提交结果未知，请重新读取核对。');
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw wireError('unknown', '读取认知树响应失败；提交结果未知，请重新读取核对。');
      }
      const result = parseCallResult(text);
      if (!response.ok && result.ok) throw wireError('unknown', '认知树响应状态与正文不一致，请重新读取核对。');
      return unwrap(result, op);
    },

    watch(treeId, listener) {
      const url = WATCH_PATH + '?sessionId=' + encodeURIComponent(sessionId);
      let source: EventSource;
      try {
        source = makeEvents(url);
      } catch (error) {
        // 订阅失败不伪造已连接；UI 仍能按需调用读操作。
        throw wireError('storage', '无法订阅认知树通知。');
      }
      const onChange = (event: MessageEvent) => {
        let notice: ChangeNotice;
        try {
          notice = JSON.parse(String(event.data)) as ChangeNotice;
        } catch (error) {
          return;
        }
        if (!notice || notice.treeId !== treeId || !Array.isArray(notice.revisions)) return;
        const change: TreeChange = { treeId, stamp: notice.stamp, revisions: notice.revisions };
        listener(change);
      };
      // 首屏读取可能先于订阅建立；重连也可能漏事件。ready 后再读才覆盖这两个间隙。
      // 空修订只是刷新信号，不生成历史或动效；实际版本由随后的读取提供。
      const onReady = () => listener({ treeId, stamp: 0, revisions: [] });
      source.addEventListener('change', onChange);
      source.addEventListener('ready', onReady);
      return () => {
        source.removeEventListener('change', onChange);
        source.removeEventListener('ready', onReady);
        source.close();
      };
    },
  };
}
