/**
 * 只注册 Connection 认证通道中的三个 exact Fetch 路由，不改 webServer、fallback、RPC 或宿主鉴权。
 * Connection 在调用 fetch 前已检查 Host/Origin、签名凭证与 owner Peer；本层不增授非 owner 权限。
 * 人侧请求固定 human，不接受 actor。宿主认证是受信 UI 边界，不声称能证明物理真人手势。
 */
import { CognitionError } from '@cognition-tree/kernel/types';
import type { HostContext } from './abi';
import { CALL_PATH, MAX_BODY_BYTES, TREES_PATH, WATCH_PATH, type ChangeNotice } from '../../types/wire';
import { parseUiCall, requireSessionId } from './input';
import { boundaryError, HostRuntime, workspaceOf } from './runtime';

/** 用封闭错误码映射 HTTP 状态，未知异常不泄漏堆栈。@param error 插件边界异常。 */
function failure(error: unknown): Response {
  const safe = boundaryError(error);
  const status = safe.code === 'missing' ? 404 : safe.code === 'storage' ? 503 : 400;
  return json({ ok: false, error: { code: safe.code, message: safe.message } }, status);
}

/** 返回不缓存的 JSON；不增设 CORS 或认证头。@param value 线协议对象。@param status HTTP 状态。 */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/**
 * 除宿主认证外拒绝显式的跨源浏览器调用；不把自报 Origin 当成身份。
 * @param request Connection 已认证的 Fetch 请求；缺少 Fetch-Metadata 的载体仍由宿主鉴权。
 */
function requireUiSource(request: Request): void {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') throw new CognitionError('invalid', '认知树界面仅接受同源请求。');
}

/** 按字节上限读 body，避免由本插件积累无界输入；在工作区与后台打开前校验。@param request 人侧 JSON 请求。 */
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new CognitionError('invalid', '请求必须使用 application/json。');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new CognitionError('invalid', '认知树请求正文过大。');
  if (!request.body) throw new CognitionError('invalid', '请求缺少 JSON 正文。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new CognitionError('invalid', '认知树请求正文过大。');
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new CognitionError('invalid', '请求正文不是有效的 UTF-8 JSON。'); }
  } finally { reader.releaseLock(); }
}

/**
 * 将成功提交的后台通知接成一个有界 SSE 流；断线/取消/解绑均释放观察者与心跳。
 * @param runtime 本插件后台观察者。
 * @param root 从可信会话解析的规范工作区。
 * @param sessionId 仅用于 ready 告知订阅对象，不是身份凭证。
 * @param signal 连接的取消信号。
 * @param streams 当前 Connection 挂载拥有的流清理集合。
 */
async function eventStream(runtime: HostRuntime, root: string, sessionId: string, signal: AbortSignal, streams: Set<() => void>): Promise<Response> {
  const encoder = new TextEncoder();
  const capacity = 1024 * 1024;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ended = false;

  /** 先移除观察者再结束流；取消后的 controller 不再访问。@param finish 是否仍需主动结束流。 */
  function stop(finish = true): void {
    if (ended) return;
    ended = true;
    off?.();
    if (timer) clearInterval(timer);
    signal.removeEventListener('abort', onAbort);
    streams.delete(close);
    if (finish) { try { controller?.close(); } catch { /* consumer 已取消或流已经结束。 */ } }
  }
  /** 关闭本连接，供挂载清理与 runtime 停用调用。 */
  function close(): void { stop(); }
  /** 客户端断线只取消观察，不撤销已经提交的数据。 */
  function onAbort(): void { stop(); }
  /** 有界入队；慢消费者关闭后由客户端重连重读，不阻塞后台提交。@param text SSE 帧。 */
  function send(text: string): void {
    if (ended || !controller) return;
    const frame = encoder.encode(text);
    if (frame.byteLength > (controller.desiredSize ?? 0)) { stop(); return; }
    controller.enqueue(frame);
  }
  /** 只转发 backend.watch 的提交事件，不从请求完成或工具输出猜测提交。@param change 已提交变更。 */
  function change(change: ChangeNotice): void { send(`event: change\ndata: ${JSON.stringify(change)}\n\n`); }

  off = await runtime.subscribe({ root, change, close });
  if (ended || signal.aborted) {
    off();
    throw new CognitionError('storage', '认知树订阅已结束。');
  }
  streams.add(close);
  signal.addEventListener('abort', onAbort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(active) {
      controller = active;
      send(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);
      timer = setInterval(() => send(': keep-alive\n\n'), 15_000);
      timer.unref?.();
    },
    cancel() { stop(false); },
  }, { highWaterMark: capacity, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

/**
 * 用现有认证通道提供八项白名单人侧操作、提交订阅与工作区只读目录；不包括手稿导入。
 * 中途失败只撤销自身贡献，目录不作为单树意图开放，旧客户端改发 bootstrapTree 也在后台调用前拒绝。
 * @param ctx Connection 注入后的宿主上下文。
 * @param runtime 插件惰性后台。
 * @returns 移除三个 exact 路由并关闭其 SSE 流的异步函数。
 */
export function registerRoutes(ctx: HostContext, runtime: HostRuntime): () => Promise<void> {
  if (!ctx.connection) throw new Error('Connection is unavailable');
  const disposers: (() => Promise<void>)[] = [];
  const streams = new Set<() => void>();
  const lifetime = new AbortController();
  let stopped = false;
  try {
    disposers.push(ctx.connection.fetch.register({
      path: CALL_PATH, methods: ['POST'], requestBody: 'streaming',
      async fetch(request) {
        try {
          if (stopped) throw new CognitionError('storage', '认知树界面已解绑。');
          runtime.assertActive();
          requireUiSource(request);
          if (new URL(request.url).search) throw new CognitionError('invalid', '操作请求不接受查询参数。');
          const call = parseUiCall(await readJson(request));
          const root = await workspaceOf(ctx, call.sessionId, request.signal);
          if (stopped) throw new CognitionError('storage', '认知树界面已解绑。');
          const value = await runtime.call('human', call.op, call.input, root, request.signal);
          return json({ ok: true, value });
        } catch (error) { return failure(error); }
      },
    }));
    disposers.push(ctx.connection.fetch.register({
      path: WATCH_PATH, methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        try {
          if (stopped) throw new CognitionError('storage', '认知树界面已解绑。');
          runtime.assertActive();
          requireUiSource(request);
          const query = new URL(request.url).searchParams;
          if ([...query.keys()].some(key => key !== 'sessionId') || query.getAll('sessionId').length !== 1) throw new CognitionError('invalid', '订阅只接受一个 sessionId。');
          const sessionId = requireSessionId(query.get('sessionId'));
          const root = await workspaceOf(ctx, sessionId, request.signal);
          if (stopped) throw new CognitionError('storage', '认知树界面已解绑。');
          return await eventStream(runtime, root, sessionId, AbortSignal.any([request.signal, lifetime.signal]), streams);
        } catch (error) { return failure(error); }
      },
    }));
    disposers.push(ctx.connection.fetch.register({
      path: TREES_PATH, methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        try {
          if (stopped) throw new CognitionError('storage', '认知树界面已解绑。');
          runtime.assertActive();
          requireUiSource(request);
          const query = new URL(request.url).searchParams;
          if ([...query.keys()].some(key => key !== 'sessionId') || query.getAll('sessionId').length !== 1) throw new CognitionError('invalid', '目录只接受一个 sessionId。');
          const sessionId = requireSessionId(query.get('sessionId'));
          const signal = AbortSignal.any([request.signal, lifetime.signal]);
          const root = await workspaceOf(ctx, sessionId, signal);
          if (stopped) throw new CognitionError('storage', '认知树界面已解绑。');
          const value = await runtime.listTrees(root, signal);
          // 已开始的读取可排空，但停用、解绑或取消后不再把旧目录交给界面。
          if (stopped) throw new CognitionError('storage', '认知树界面已解绑。');
          runtime.assertActive();
          signal.throwIfAborted();
          return json({ ok: true, value });
        } catch (error) { return failure(error); }
      },
    }));
  } catch (error) {
    stopped = true;
    lifetime.abort();
    for (const off of disposers.reverse()) void off().catch(() => {});
    throw error;
  }
  return async () => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    for (const close of [...streams]) close();
    await Promise.allSettled(disposers.reverse().map(dispose => dispose()));
  };
}
