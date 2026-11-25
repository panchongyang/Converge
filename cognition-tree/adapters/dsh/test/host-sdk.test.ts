/**
 * 对已安装 DSH 0.2.2-rc.1 的真实 Cordis/Tools/Session/Connection ABI 作无监听器嵌入测试。
 * 所有 signing records 只在本例内存中生成；绝不加载真实 credential provider、profile 或 webServer。
 * 其它机器可设置 DSH_SDK_TEST_ROOT 指向 SDK 安装根；没有已装 SDK 时明确 skip，不以 stub 顶替。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '../src/server/backend/index';
import { inject, installHost } from '../src/server/host/index';
import type { HostContext, HostTool, JsonSchema, SessionIdentity } from '../src/server/host/abi';
import { AI_TOOLS, CALL_PATH, TREES_PATH, WATCH_PATH, type WorkspaceTreeDirectory } from '../src/types/wire';

const SDK_ROOT = process.env.DSH_SDK_TEST_ROOT?.trim();
const hasSdk = Boolean(SDK_ROOT && existsSync(join(SDK_ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js')));
const sdk = createRequire(SDK_ROOT && hasSdk ? join(SDK_ROOT, 'package.json') : import.meta.url);

type Fiber = { await(): Promise<unknown>; dispose(): Promise<void>; readonly ctx: TestContext };
type Peer = { principal: { kind: string } };
interface ToolsApi {
  get(name: string): HostTool | undefined;
  definitions(): HostTool[];
  schemas(): unknown[];
}
interface ConnectionApi {
  browserPeer: Peer;
  admit(request: { headers: Headers | Record<string, string> }): { peer: Peer } | { rejection: number };
  createPeer(options: { principal: { kind: string } }): Peer;
  authenticatedUrl(base: string): string;
  authorizeIndex(req: { method: string; url: string; headers: Record<string, string> }, res: { writeHead(status: number, headers?: Record<string, string>): unknown; end(): unknown }): boolean;
  fetch: { register(route: { path: string; methods: ['GET']; requestBody: 'buffered'; fetch(req: Request): Promise<Response> }): () => Promise<void> };
  createSharedFetchHandler(channel: '/api'): {
    requestBodyMode(input: { method: string; url: URL }): string;
    fetch(request: Request, peer: Peer): Promise<Response>;
  };
}
interface TestContext {
  provide(name: string, value: unknown): () => Promise<void>;
  plugin(plugin: unknown): Fiber;
  get(name: string): unknown;
  tools: ToolsApi;
  connection: ConnectionApi;
  sessions: { create(id: string, options: { meta: { cwd: string } }): SessionIdentity; get(id: string): SessionIdentity | undefined };
}

/** 在独立的真实 Cordis 容器内提供纯内存依赖，没有任何网络 carrier 或文件 provider。 */
async function embedded() {
  const { Context } = sdk('@deepseek-ai/cordis') as { Context: new () => TestContext };
  const { ToolsService, assertSupportedJsonSchema, validateJsonSchemaValue } = sdk('@deepseek-ai/dsh-tools') as {
    ToolsService: new (ctx: TestContext) => unknown;
    assertSupportedJsonSchema(schema: JsonSchema): void;
    validateJsonSchemaValue(schema: JsonSchema, value: unknown): string[];
  };
  const { SessionStore } = sdk('@deepseek-ai/dsh-session') as { SessionStore: new (ctx: TestContext) => unknown };
  const connectionPlugin = sdk('@deepseek-ai/dsh-client-connection');
  const root = new Context();
  const records = new Map<string, unknown>();
  const base = root.plugin({ name: 'isolated-host-test-capabilities', apply(ctx: TestContext) {
    ctx.provide('systemPrompt', { tools: () => () => {} });
    new ToolsService(ctx);
    new SessionStore(ctx);
    ctx.provide('workspaceRegistry', { resolveByPath: async (cwd: string) => ({ path: cwd }) });
    ctx.provide('credentials', {
      async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>) {
        const next = await mutate(records.get(key));
        if (next !== undefined) records.set(key, next);
        return records.get(key);
      },
    });
  } });
  await base.await();
  const connection = root.plugin(connectionPlugin);
  await connection.await();
  const calls = vi.fn(async () => 'saved');
  const close = vi.fn(async () => {});
  const listTrees = vi.fn(async (root: string): Promise<WorkspaceTreeDirectory> => ({
    trees: [{ treeId: 'T1', rootId: 'legacy-root', rootQuestion: root === 'D:\\isolated\\workspace' ? '当前工作区的根问题' : '另一工作区的根问题' }], unavailable: [],
  }));
  const factory = vi.fn(() => ({ call: calls as Backend['call'], listTrees, close, watch: () => () => {} } satisfies Backend));
  const session = root.sessions.create('isolated-session', { meta: { cwd: 'D:\\isolated\\workspace' } });
  const otherSession = root.sessions.create('other-session', { meta: { cwd: 'D:\\isolated\\other-workspace' } });
  const plugin = root.plugin({ name: 'isolated-cognition-tree-test', inject, apply(ctx: TestContext) { installHost(ctx as unknown as HostContext, factory); } });
  await plugin.await();
  const handler = root.connection.createSharedFetchHandler('/api');
  await vi.waitFor(() => expect(handler.requestBodyMode({ method: 'POST', url: new URL(`http://127.0.0.1${CALL_PATH}`) })).toBe('streaming'));

  /** 通过真实 BrowserAuth 的本例新鲜 launch token 换取本例签名 cookie；不打印任何凭证。 */
  function login(): string {
    const url = new URL(root.connection.authenticatedUrl('http://127.0.0.1/'));
    let cookie = '';
    let status = 0;
    expect(root.connection.authorizeIndex({ method: 'GET', url: `${url.pathname}${url.search}`, headers: { host: '127.0.0.1' } }, {
      writeHead(value, headers) { status = value; cookie = headers?.['set-cookie']?.split(';')[0] ?? ''; }, end() {},
    })).toBe(false);
    expect(status).toBe(303);
    expect(cookie).not.toBe('');
    return cookie;
  }
  const cookie = login();
  /** 构造内存请求，不发网络请求。@param overrides 自定义坏头。@param sessionId 会话定位符。@param call 待验证的操作与具名参数。 */
  function request(overrides: Record<string, string> = {}, sessionId = session.id, call: { op: string; input: unknown } = { op: 'confirm', input: { treeId: 'T1', target: { revisionId: 'r1' } } }): Request {
    return new Request(`http://127.0.0.1${CALL_PATH}`, {
      method: 'POST', headers: { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...overrides },
      body: JSON.stringify({ sessionId, ...call }),
    });
  }
  /** 认证目录GET只传会话定位符，不发网络请求。@param overrides 自定义坏头。@param query 唯一允许的sessionId或测试坏query。 */
  function treesRequest(overrides: Record<string, string> = {}, query = `sessionId=${session.id}`): Request {
    return new Request(`http://127.0.0.1${TREES_PATH}?${query}`, {
      headers: { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie, 'sec-fetch-site': 'same-origin', ...overrides },
    });
  }
  /** 实际宿主 carrier 的 admit→shared handler 组成，仍没有 socket 或端口。@param request 内存请求。 */
  async function dispatch(request: Request): Promise<Response> {
    const admission = root.connection.admit({ headers: request.headers });
    return 'rejection' in admission ? new Response(null, { status: admission.rejection }) : handler.fetch(request, admission.peer);
  }
  return {
    root, base, connection, plugin, calls, listTrees, close, factory, records, handler, request, treesRequest, dispatch, session, otherSession,
    assertSupportedJsonSchema, validateJsonSchemaValue,
    async dispose() { await plugin.dispose(); await connection.dispose(); await base.dispose(); },
  };
}

describe.skipIf(!hasSdk)('已安装真实 DSH SDK 的无监听器嵌入契约', () => {
  it('真实ToolsService仅接受六个具名AI工具与canonical output，SessionStore绑定能执行且懒加载', async () => {
    const f = await embedded();
    try {
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.root.tools.definitions().map(tool => tool.name)).toEqual([
        'cognition_tree_create_tree', 'cognition_tree_add_branch', 'cognition_tree_decide_node',
        'cognition_tree_read_view', 'cognition_tree_read_history', 'cognition_tree_read_unconfirmed',
      ]);
      expect(f.root.tools.schemas()).toHaveLength(6);
      for (const tool of f.root.tools.definitions()) {
        f.assertSupportedJsonSchema(tool.parameters);
        f.assertSupportedJsonSchema(tool.output.schema);
      }
      const input = { treeId: 'T1', limit: 5 };
      const tool = f.root.tools.get(AI_TOOLS.readHistory)!;
      expect(f.validateJsonSchemaValue(tool.parameters, input)).toEqual([]);
      expect(f.validateJsonSchemaValue(tool.parameters, { ...input, actor: 'human' }).length).toBeGreaterThan(0);
      const execution = { agent: { id: f.session.id, session: f.session }, signal: new AbortController().signal };
      expect(await tool.execute(input, execution)).toBe('saved');
      expect(f.calls).toHaveBeenLastCalledWith('D:\\isolated\\workspace', 'ai', 'readHistory', input);
      expect(tool.output.render(input, 'saved')).toEqual([{ type: 'text', text: '"saved"' }]);
      expect(f.root.tools.get('cognition_tree_read_node')).toBeUndefined();
      expect(AI_TOOLS).not.toHaveProperty('readNode');
      // AI 单点入口撤掉后，认证人侧 /call 仍保留 readNode。
      const humanRead = await f.dispatch(f.request({}, f.session.id, { op: 'readNode', input: { treeId: 'T1', nodeId: 'T1' } }));
      expect(await humanRead.json()).toEqual({ ok: true, value: 'saved' });
      expect(f.calls).toHaveBeenLastCalledWith('D:\\isolated\\workspace', 'human', 'readNode', { treeId: 'T1', nodeId: 'T1' });
      expect(f.root.tools.get('cognition_tree_confirm')).toBeUndefined();
      expect(f.root.tools.get('cognition_tree_bootstrap_tree')).toBeUndefined();
      const mutation = f.root.tools.get(AI_TOOLS.addBranch)!;
      expect(mutation.output.presentationMeta?.({ treeId: 'T1' }, 'n2')).toEqual({ kind: 'cognition-tree', op: 'addBranch', treeId: 'T1', nodeId: 'n2' });
    } finally { await f.dispose(); }
  });

  it('真实SDK建树schema与execute只收treeId/rootQuestion，AI和认证人侧分别绑定actor且不生成新卡类型', async () => {
    const f = await embedded();
    try {
      const input = { treeId: 'NewTree', rootQuestion: '我们需要对齐什么？' };
      const tool = f.root.tools.get(AI_TOOLS.createTree)!;
      expect(f.validateJsonSchemaValue(tool.parameters, input)).toEqual([]);
      const execution = { agent: { id: f.session.id, session: f.session }, signal: new AbortController().signal };
      for (const extra of [{ seed: {} }, { nodes: [] }, { actor: 'human' }, { op: 'confirm' }, { op: 'bootstrapTree' }]) {
        expect(f.validateJsonSchemaValue(tool.parameters, { ...input, ...extra }).length).toBeGreaterThan(0);
        await expect(tool.execute({ ...input, ...extra }, execution)).rejects.toMatchObject({ code: 'invalid' });
      }
      expect(f.factory).not.toHaveBeenCalled();
      f.calls.mockResolvedValue(input.treeId);
      expect(await tool.execute(input, execution)).toBe(input.treeId);
      expect(f.calls).toHaveBeenLastCalledWith('D:\\isolated\\workspace', 'ai', 'createTree', input);
      expect(tool.output.presentationMeta).toBeUndefined();
      const human = await f.dispatch(f.request({}, f.session.id, { op: 'createTree', input }));
      expect(await human.json()).toEqual({ ok: true, value: input.treeId });
      expect(f.calls).toHaveBeenLastCalledWith('D:\\isolated\\workspace', 'human', 'createTree', input);
    } finally { await f.dispose(); }
  });

  it('真实认证UI改发旧bootstrapTree或携带seed仍被拒绝，零后台调用且不受工作区选择影响', async () => {
    const f = await embedded();
    try {
      for (const session of [f.session, f.otherSession]) {
        for (const call of [
          { op: 'bootstrapTree', input: { seed: { treeId: 'T1', nodes: [], refs: [], history: [] } } },
          { op: 'createTree', input: { treeId: 'T1', rootQuestion: '根问题', seed: {} } },
        ]) {
          const response = await f.dispatch(f.request({}, session.id, call));
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid' } });
        }
      }
      expect(f.calls).not.toHaveBeenCalled();
      expect(f.factory).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it('真实signed-cookie/Host/Origin/owner拒绝未认证、伪造cookie、跨源和非owner；合法UI可以确认', async () => {
    const f = await embedded();
    try {
      expect((await f.dispatch(f.request({ cookie: '' }))).status).toBe(401);
      expect((await f.dispatch(f.request({ cookie: 'forged=not-a-cookie' }))).status).toBe(401);
      expect((await f.dispatch(f.request({ host: 'attacker.invalid' }))).status).toBe(403);
      expect((await f.dispatch(f.request({ origin: 'https://attacker.invalid' }))).status).toBe(403);
      expect((await f.dispatch(f.request({ 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
      const guest = f.root.connection.createPeer({ principal: { kind: 'isolated-non-owner' } });
      expect((await f.handler.fetch(f.request(), guest)).status).toBe(403);
      expect(f.factory).not.toHaveBeenCalled();
      const success = await f.dispatch(f.request());
      expect(await success.json()).toEqual({ ok: true, value: 'saved' });
      expect(f.calls).toHaveBeenLastCalledWith('D:\\isolated\\workspace', 'human', 'confirm', { treeId: 'T1', target: { revisionId: 'r1' } });
      expect((await f.dispatch(f.request({}, f.otherSession.id))).status).toBe(200);
      expect(f.calls).toHaveBeenLastCalledWith('D:\\isolated\\other-workspace', 'human', 'confirm', { treeId: 'T1', target: { revisionId: 'r1' } });
    } finally { await f.dispose(); }
  });

  it('真实目录GET仍受signed-cookie/Host/Origin/owner保护；拒绝未授权请求且不启动后台', async () => {
    const f = await embedded();
    try {
      for (const [headers, status] of [
        [{ cookie: '' }, 401], [{ cookie: 'forged=not-a-cookie' }, 401],
        [{ host: 'attacker.invalid' }, 403], [{ origin: 'https://attacker.invalid' }, 403],
        [{ 'sec-fetch-site': 'cross-site' }, 403],
      ] as [Record<string, string>, number][]) expect((await f.dispatch(f.treesRequest(headers))).status).toBe(status);
      const guest = f.root.connection.createPeer({ principal: { kind: 'isolated-non-owner' } });
      expect((await f.handler.fetch(f.treesRequest(), guest)).status).toBe(403);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.listTrees).not.toHaveBeenCalled();
      expect(f.calls).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it('真实目录GET仅收单个可信会话，无会话/额外路径不执行，成功保留实际根ID并隔离工作区', async () => {
    const f = await embedded();
    try {
      for (const query of ['', 'sessionId=', `sessionId=${f.session.id}&sessionId=${f.otherSession.id}`, `sessionId=${f.session.id}&path=D%3A%5Coutside`, `sessionId=${f.session.id}&actor=human`, `sessionId=${f.session.id}&treeId=T1`]) {
        expect((await f.dispatch(f.treesRequest({}, query))).status).toBe(400);
      }
      expect((await f.dispatch(f.treesRequest({}, 'sessionId=missing'))).status).toBe(404);
      const wrongMethod = new Request(f.treesRequest(), { method: 'POST' });
      expect((await f.dispatch(wrongMethod)).status).toBe(404); // shared Fetch 只匹配显式注册的方法。
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.listTrees).not.toHaveBeenCalled();
      const persistence = f.root.plugin({ name: 'isolated-session-metadata', apply(ctx: TestContext) {
        ctx.provide('sessionPersistence', { stat: async (id: string) => id === 'cold-session' ? { header: { cwd: 'D:\\isolated\\other-workspace' } } : undefined });
      } });
      await persistence.await();
      try {
        expect((await f.dispatch(f.treesRequest({}, 'sessionId=cold-session'))).status).toBe(200);
        expect(f.listTrees).toHaveBeenLastCalledWith('D:\\isolated\\other-workspace');
      } finally { await persistence.dispose(); }
      const first = await f.dispatch(f.treesRequest());
      expect(first.headers.get('cache-control')).toBe('no-store');
      expect(await first.json()).toEqual({ ok: true, value: { trees: [{ treeId: 'T1', rootId: 'legacy-root', rootQuestion: '当前工作区的根问题' }], unavailable: [] } });
      expect(f.listTrees).toHaveBeenLastCalledWith('D:\\isolated\\workspace');
      const other = await f.dispatch(f.treesRequest({}, `sessionId=${f.otherSession.id}`));
      expect(await other.json()).toEqual({ ok: true, value: { trees: [{ treeId: 'T1', rootId: 'legacy-root', rootQuestion: '另一工作区的根问题' }], unavailable: [] } });
      expect(f.listTrees).toHaveBeenLastCalledWith('D:\\isolated\\other-workspace');
      expect(f.calls).not.toHaveBeenCalled();
      expect(f.root.tools.definitions()).toHaveLength(6);
      expect(f.root.tools.get('cognition_tree_list_trees')).toBeUndefined();
    } finally { await f.dispose(); }
  });

  it('真实SDK并行目录请求保留各自工作区，先完成另一工作区不会污染延迟中的结果', async () => {
    const f = await embedded();
    let release!: (value: WorkspaceTreeDirectory) => void;
    f.listTrees.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    try {
      const first = f.dispatch(f.treesRequest());
      await vi.waitFor(() => expect(f.listTrees).toHaveBeenCalledOnce());
      const other = await f.dispatch(f.treesRequest({}, `sessionId=${f.otherSession.id}`));
      expect(await other.json()).toEqual({ ok: true, value: { trees: [{ treeId: 'T1', rootId: 'legacy-root', rootQuestion: '另一工作区的根问题' }], unavailable: [] } });
      const current: WorkspaceTreeDirectory = { trees: [{ treeId: 'A', rootId: 'actual-A', rootQuestion: '延迟读回的根问题' }], unavailable: ['DamagedTree'] };
      release(current);
      expect(await (await first).json()).toEqual({ ok: true, value: current });
      expect(f.calls).not.toHaveBeenCalled();
    } finally { release?.({ trees: [], unavailable: [] }); await f.dispose(); }
  });

  it('真实Cordis卸载清掉自身tools/routes/SSE，保留其它feature，重新加载没有重复贡献', async () => {
    const f = await embedded();
    const offOther = f.root.connection.fetch.register({ path: '/api/isolated-other', methods: ['GET'], requestBody: 'buffered', fetch: async () => new Response('other') });
    try {
      const watch = await f.handler.fetch(new Request(`http://127.0.0.1${WATCH_PATH}?sessionId=${f.session.id}`), f.root.connection.browserPeer);
      const reader = watch.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
      await f.plugin.dispose();
      expect((await reader.read()).done).toBe(true);
      expect(f.root.tools.definitions()).toHaveLength(0);
      expect((await f.handler.fetch(f.request(), f.root.connection.browserPeer)).status).toBe(404);
      expect((await f.handler.fetch(f.treesRequest(), f.root.connection.browserPeer)).status).toBe(404);
      expect((await f.handler.fetch(new Request(`http://127.0.0.1${WATCH_PATH}?sessionId=${f.session.id}`), f.root.connection.browserPeer)).status).toBe(404);
      expect(await (await f.handler.fetch(new Request('http://127.0.0.1/api/isolated-other'), f.root.connection.browserPeer)).text()).toBe('other');
      expect(f.close).toHaveBeenCalledTimes(1);
      const again = f.root.plugin({ name: 'isolated-cognition-tree-again', inject, apply(ctx: TestContext) { installHost(ctx as unknown as HostContext, f.factory); } });
      await again.await();
      await vi.waitFor(() => expect(f.root.tools.definitions()).toHaveLength(6));
      expect((await f.dispatch(f.treesRequest())).status).toBe(200);
      expect(f.factory).toHaveBeenCalledTimes(2);
      await again.dispose();
      expect(f.close).toHaveBeenCalledTimes(2);
    } finally { await offOther(); await f.dispose(); }
  });
});
