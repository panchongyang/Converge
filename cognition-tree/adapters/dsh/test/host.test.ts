/** 宿主边界隔离测试：不连接真实 profile、服务或端口；后台与 Cordis 生命周期使用局部替身。 */
import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@cognition-tree/kernel/catalog';
import type { OpInput, OpName, OpOutput } from '@cognition-tree/kernel/catalog/contracts';
import { MemoryTreeStore } from '@cognition-tree/kernel/storage/memory';
import { CognitionError, type NodeDetail, type TreeView, type ViewNode } from '@cognition-tree/kernel/types';
import { createT1Seed } from '../../browser/src/fixtures/t1-seed';
import { aiReadViewCost } from '../src/server/ai-view-wire';
import type { Backend } from '../src/server/backend/index';
import { installHost, inject, name } from '../src/server/host/index';
import type { FetchRoute, HostContext, HostTool, JsonSchema, SessionIdentity, ToolExecution } from '../src/server/host/abi';
import { AI_TOOLS, CALL_PATH, TREES_PATH, WATCH_PATH, type UiOp, type WorkspaceTreeDirectory } from '../src/types/wire';
import { HostRuntime, workspaceOf } from '../src/server/host/runtime';
import { containsDataDirectory } from '../src/server/host/file-policy';
import { join } from 'node:path';

const ROOT_A = 'D:\\isolation\\alpha';
const ROOT_B = 'D:\\isolation\\beta';
const INPUT = { treeId: 'T1', nodeId: 'T1.1' };
const HISTORY_INPUT = { treeId: 'T1', limit: 5 };
const CREATE_INPUT = { treeId: 'NewTree', rootQuestion: '我们需要对齐什么？' };
type Call = { root: string; actor: string; op: OpName; input: OpInput[OpName] };

/** 每例独立的宿主注册表和后台；仅有明确的会话/工作区集合是可信事实。 */
function fixture(options: { connection?: boolean; failRoute?: string } = {}) {
  const tools = new Map<string, HostTool>();
  const routes = new Map<string, FetchRoute>();
  const sessions = new Map<string, SessionIdentity>();
  const persisted = new Map<string, { header: { cwd?: string } }>();
  const workspaces = new Map([[ROOT_A, ROOT_A], [ROOT_B, ROOT_B], ['D:\\alias\\alpha', ROOT_A]]);
  const effects: (() => void | Promise<void>)[] = [];
  const routeEffects: (() => void | Promise<void>)[] = [];
  const calls: Call[] = [];
  const listeners = new Set<Parameters<Backend['watch']>[0]>();
  const close = vi.fn(async () => {});
  const call = vi.fn(async (root: string, actor: string, op: OpName, input: OpInput[OpName]) => {
    calls.push({ root, actor, op, input });
    return (op === 'createTree' ? (input as OpInput['createTree']).treeId : 'result') as OpOutput[OpName];
  });
  const directories = new Map<string, WorkspaceTreeDirectory>([
    [ROOT_A, { trees: [{ treeId: 'T1', rootId: 'actual-root-a', rootQuestion: '甲工作区的根问题' }], unavailable: ['DamagedTree'] }],
    [ROOT_B, { trees: [{ treeId: 'T1', rootId: 'actual-root-b', rootQuestion: '乙工作区的根问题' }], unavailable: [] }],
  ]);
  const listTrees = vi.fn(async (root: string): Promise<WorkspaceTreeDirectory> => directories.get(root)!);
  const backend: Backend = {
    call: call as Backend['call'], listTrees, close,
    watch(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const factory = vi.fn((): Backend | Promise<Backend> => backend);
  const warn = vi.fn();
  let connected = options.connection !== false;
  let mount: ((ctx: HostContext) => void) | undefined;
  const services = new Map<string, unknown>([['sessionPersistence', { stat: vi.fn(async (id: string) => persisted.get(id)) }]]);
  const ctx: HostContext = {
    get: key => services.get(key),
    tools: { register(tool) { if (tools.has(tool.name)) throw new Error('duplicate tool'); tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } },
    sessions: { get: id => sessions.get(id) },
    workspaceRegistry: { resolveByPath: vi.fn(async cwd => { const path = workspaces.get(cwd); return path ? { path } : undefined; }) },
    connection: { fetch: { register(route) { if (route.path === options.failRoute) throw new Error('simulated route registration failure'); if (routes.has(route.path)) throw new Error('duplicate route'); routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
    logger: { warn },
    inject(_deps, callback) { mount = callback; if (connected) callback({ ...ctx, effect(execute) { routeEffects.push(execute()); } }); },
    effect(execute) { effects.push(execute()); },
  };
  const runtime = installHost(ctx, factory);
  const session = (id: string, cwd?: string) => { const value = { id, header: cwd === undefined ? {} : { cwd } }; sessions.set(id, value); return value; };
  session('a', ROOT_A); session('b', ROOT_B);
  const exec = (id = 'a'): ToolExecution => ({ agent: { id, session: sessions.get(id)! }, signal: new AbortController().signal });
  const invoke = (tool: string = AI_TOOLS.readHistory, args: unknown = HISTORY_INPUT, execution = exec()) => tools.get(tool)!.execute(args, execution);
  const request = (op: string, input: unknown = INPUT, extra: Record<string, unknown> = {}, sessionId = 'a') => new Request(`http://dsh.internal${CALL_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ sessionId, op, input, ...extra }),
  });
  const http = (req: Request) => routes.get(new URL(req.url).pathname)!.fetch(req);
  const post = (op: string, input: unknown = INPUT, extra: Record<string, unknown> = {}, sessionId = 'a') => http(request(op, input, extra, sessionId));
  const watch = (id = 'a', signal?: AbortSignal) => http(new Request(`http://dsh.internal${WATCH_PATH}?sessionId=${id}`, { signal }));
  const treesRequest = (query = 'sessionId=a', signal?: AbortSignal) => new Request(`http://dsh.internal${TREES_PATH}?${query}`, { signal, headers: { 'sec-fetch-site': 'same-origin' } });
  const list = (id = 'a') => http(treesRequest(`sessionId=${encodeURIComponent(id)}`));
  const emit = (root = ROOT_A, stamp = 1) => { for (const listener of listeners) listener(root, { treeId: 'T1', stamp, revisions: [] }); };
  return {
    ctx, runtime, backend, factory, tools, routes, sessions, persisted, workspaces, call, calls, listTrees, directories, close, warn, listeners, services,
    exec, invoke, request, post, http, watch, treesRequest, list, emit, session,
    async unmount() { for (const dispose of routeEffects.splice(0).reverse()) await dispose(); },
    connect() { connected = true; mount?.({ ...ctx, effect(execute) { routeEffects.push(execute()); } }); },
    async dispose() { for (const dispose of effects.splice(0).reverse()) await dispose(); for (const dispose of routeEffects.splice(0).reverse()) await dispose(); },
  };
}

/** 读取恰好一个 SSE 队列块；断线返回空串。@param reader 当前流 reader。 */
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const item = await reader.read();
  return item.done ? '' : new TextDecoder().decode(item.value);
}

describe('DSH 插件的可信入口', () => {
  it('声明标准 Cordis 插件且激活不创建后台；没有全局消息事件或服务替换', async () => {
    const f = fixture();
    expect(name).toBe('cognition-tree');
    expect(inject).toEqual(['tools', 'sessions', 'workspaceRegistry']);
    expect([...f.tools.keys()]).toEqual([
      'cognition_tree_create_tree', 'cognition_tree_add_branch', 'cognition_tree_decide_node',
      'cognition_tree_read_view', 'cognition_tree_read_history', 'cognition_tree_read_unconfirmed',
    ]);
    expect(Object.values(AI_TOOLS)).toEqual([...f.tools.keys()]);
    expect(AI_TOOLS).not.toHaveProperty('readNode');
    expect([...f.routes.keys()]).toEqual([CALL_PATH, WATCH_PATH, TREES_PATH]);
    expect(f.factory).not.toHaveBeenCalled();
    await f.dispose();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.tools.size).toBe(0);
    expect(f.routes.size).toBe(0);
  });

  it('六工具固定AI并由live Session与registry确定规范工作区；同树ID不串工作区', async () => {
    const f = fixture();
    await f.invoke();
    await f.invoke(AI_TOOLS.readHistory, HISTORY_INPUT, f.exec('b'));
    f.session('alias', 'D:\\alias\\alpha');
    await f.invoke(AI_TOOLS.readHistory, HISTORY_INPUT, f.exec('alias'));
    expect(f.calls.map(x => [x.root, x.actor, x.op])).toEqual([[ROOT_A, 'ai', 'readHistory'], [ROOT_B, 'ai', 'readHistory'], [ROOT_A, 'ai', 'readHistory']]);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(1);
    expect(f.tools.has('cognition_tree_confirm')).toBe(false);
    expect(f.tools.has('cognition_tree_bootstrap_tree')).toBe(false);
    await f.dispose();
  });

  it('拒绝工具自报身份、路径、sessionId及伪造Session；失败不启动后台', async () => {
    const f = fixture();
    for (const extra of [{ actor: 'human' }, { cwd: ROOT_B }, { path: ROOT_B }, { workspaceRoot: ROOT_B }, { identity: 'human' }, { sessionId: 'b' }, { op: 'confirm' }]) {
      await expect(f.invoke(AI_TOOLS.readHistory, { ...HISTORY_INPUT, ...extra })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(f.invoke(AI_TOOLS.readHistory, HISTORY_INPUT, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.invoke(AI_TOOLS.readHistory, HISTORY_INPUT, { agent: { id: 'a', session: { id: 'a', header: { cwd: ROOT_B } } }, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'invalid' });
    f.session('empty');
    await expect(f.invoke(AI_TOOLS.readHistory, HISTORY_INPUT, f.exec('empty'))).rejects.toMatchObject({ code: 'invalid' });
    f.session('unregistered', 'D:\\outside');
    await expect(f.invoke(AI_TOOLS.readHistory, HISTORY_INPUT, f.exec('unregistered'))).rejects.toMatchObject({ code: 'invalid' });
    expect(f.factory).not.toHaveBeenCalled();
    await f.dispose();
  });

  it('人侧仅调用八项白名单意图；建树与确认固定human且不借工具或消息钩子', async () => {
    const f = fixture();
    const inputs: Record<UiOp, unknown> = {
      createTree: CREATE_INPUT,
      addBranch: { treeId: 'T1', placement: {}, draft: {} }, decideNode: { treeId: 'T1', nodeId: 'N', decision: {} },
      confirm: { treeId: 'T1', target: { revisionId: 'R1' } },
      readNode: INPUT, readHistory: { treeId: 'T1', limit: 5 }, readUnconfirmed: { treeId: 'T1', by: ['ai', 'import'], limit: 5 },
      readView: { treeId: 'T1', focus: { root: true }, expand: {}, budget: {}, onLimit: 'fold' },
    };
    for (const [op, input] of Object.entries(inputs)) {
      expect(await (await f.post(op, input)).json()).toEqual({ ok: true, value: op === 'createTree' ? CREATE_INPUT.treeId : 'result' });
    }
    expect(f.calls).toHaveLength(8);
    expect(f.calls.every(x => x.actor === 'human' && x.root === ROOT_A)).toBe(true);
    // 这里只验证传输翻译；这些局部替身 input 不作为内核参数正确性的证据。
    await f.dispose();
  });

  it('人和AI建树只转发treeId/rootQuestion并返回树ID；actor由入口绑定且不新增聊天卡类型', async () => {
    const f = fixture();
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).resolves.toBe(CREATE_INPUT.treeId);
    expect(await (await f.post('createTree', CREATE_INPUT)).json()).toEqual({ ok: true, value: CREATE_INPUT.treeId });
    expect(f.calls).toEqual([
      { root: ROOT_A, actor: 'ai', op: 'createTree', input: CREATE_INPUT },
      { root: ROOT_A, actor: 'human', op: 'createTree', input: CREATE_INPUT },
    ]);
    expect(f.tools.get(AI_TOOLS.createTree)!.output.presentationMeta).toBeUndefined();
    await f.dispose();
  });

  it('关闭手稿入口后改HTTP请求也不能自举；所有工作区的旧bootstrapTree op均在后台前拒绝', async () => {
    const f = fixture();
    f.persisted.set('cold', { header: { cwd: ROOT_B } });
    for (const sessionId of ['a', 'b', 'cold']) {
      const response = await f.post('bootstrapTree', { seed: { treeId: 'T1', nodes: [], refs: [], history: [] } }, {}, sessionId);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid' } });
    }
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    await f.dispose();
  });

  it('建树拒绝seed、批量节点和多余身份/意图参数，不能改请求绕过手稿入口或AI确认边界', async () => {
    const f = fixture();
    for (const extra of [{ seed: {} }, { nodes: [] }, { refs: [] }, { history: [] }, { actor: 'human' }, { op: 'bootstrapTree' }, { op: 'confirm' }, { sessionId: 'b' }, { cwd: ROOT_B }]) {
      const input = { ...CREATE_INPUT, ...extra };
      await expect(f.invoke(AI_TOOLS.createTree, input)).rejects.toMatchObject({ code: 'invalid' });
      expect((await f.post('createTree', input)).status).toBe(400);
    }
    for (const input of [{ seed: {} }, { treeId: 'T1' }, { rootQuestion: '根问题' }]) {
      await expect(f.invoke(AI_TOOLS.createTree, input)).rejects.toMatchObject({ code: 'invalid' });
      expect((await f.post('createTree', input)).status).toBe(400);
    }
    const signal = new AbortController().signal;
    // 故意绕过TS模拟旧接线/不受类型检查的调用；runtime仍不得把它送往私有worker。
    expect(() => f.runtime.call('human', 'bootstrapTree' as UiOp, { seed: {} } as never, ROOT_A, signal)).toThrow(CognitionError);
    expect(() => f.runtime.call('ai', 'confirm', { treeId: 'T1', target: { revisionId: 'r' } }, ROOT_A, signal)).toThrow(CognitionError);
    expect(f.tools.has('cognition_tree_confirm')).toBe(false);
    expect(f.tools.has('cognition_tree_bootstrap_tree')).toBe(false);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    await f.dispose();
  });

  it('会话locator只查可信live/persisted header；不存在、相对cwd或未注册工作区都失败关闭', async () => {
    const f = fixture();
    f.persisted.set('cold', { header: { cwd: ROOT_B } });
    expect(await (await f.post('readNode', INPUT, {}, 'cold')).json()).toMatchObject({ ok: true });
    expect(f.calls[0]?.root).toBe(ROOT_B);
    expect((await f.post('readNode', INPUT, {}, 'missing')).status).toBe(404);
    f.session('relative', '.');
    expect((await f.post('readNode', INPUT, {}, 'relative')).status).toBe(400);
    f.session('bad', 'D:\\unknown');
    expect((await f.post('readNode', INPUT, {}, 'bad')).status).toBe(400);
    expect(f.calls).toHaveLength(1);
    await f.dispose();
  });

  it('HTTP拒绝额外身份字段、未知op、越界形状、跨站来源和错误正文，且零后台副作用', async () => {
    const f = fixture();
    for (const extra of [{ actor: 'human' }, { cwd: ROOT_B }, { workspaceRoot: ROOT_B }, { identity: {} }, { path: ROOT_B }]) {
      expect((await f.post('confirm', { treeId: 'T1', target: { revisionId: 'r' } }, extra)).status).toBe(400);
    }
    expect((await f.post('__proto__')).status).toBe(400);
    expect((await f.post('readNode', { ...INPUT, actor: 'human' })).status).toBe(400);
    const cross = f.request('readNode'); cross.headers.set('sec-fetch-site', 'cross-site');
    expect((await f.http(cross)).status).toBe(400);
    const invalid = new Request(`http://dsh.internal${CALL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
    expect((await f.http(invalid)).status).toBe(400);
    const simple = new Request(`http://dsh.internal${CALL_PATH}`, { method: 'POST', body: '{}' });
    expect((await f.http(simple)).status).toBe(400);
    const large = f.request('readNode'); large.headers.set('content-length', '999999999');
    expect((await f.http(large)).status).toBe(400);
    expect(f.factory).not.toHaveBeenCalled();
    await f.dispose();
  });

  it('headless不要求Connection；依赖稍后出现时才添加自身路由', async () => {
    const f = fixture({ connection: false });
    expect(f.routes.size).toBe(0);
    await f.invoke();
    f.connect();
    expect(f.routes.size).toBe(3);
    await f.dispose();
  });
});

describe('工作区根问题只读目录', () => {
  it('GET只经可信会话与registry读取当前工作区，保留真实根ID/问题和不可用项且不分派catalog', async () => {
    const f = fixture();
    f.persisted.set('cold', { header: { cwd: ROOT_B } });
    f.session('alias', 'D:\\alias\\alpha');
    const route = f.routes.get(TREES_PATH)!;
    expect(route.methods).toEqual(['GET']);
    expect(route.requestBody).toBe('buffered');
    for (const [id, root] of [['a', ROOT_A], ['b', ROOT_B], ['cold', ROOT_B], ['alias', ROOT_A]]) {
      const response = await f.list(id);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ ok: true, value: f.directories.get(root!) });
      expect(f.listTrees).toHaveBeenLastCalledWith(root);
    }
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.call).not.toHaveBeenCalled();
    expect((await f.post('listTrees', {})).status).toBe(400);
    expect(f.tools.size).toBe(6);
    expect(f.tools.has('cognition_tree_list_trees')).toBe(false);
    await f.dispose();
  });

  it('目录只收一个sessionId；缺失/伪造路径/身份/未知会话与无可信工作区均不打开后台', async () => {
    const f = fixture();
    for (const query of ['', 'sessionId=', 'sessionId=%20', 'sessionId=a&sessionId=b', 'sessionId=a&root=D%3A%5Coutside', 'sessionId=a&path=x', 'sessionId=a&treeId=T1', 'sessionId=a&actor=human', 'sessionId=a&workspaceRoot=x', `sessionId=${'a'.repeat(257)}`]) {
      expect((await f.http(f.treesRequest(query))).status).toBe(400);
    }
    expect((await f.list('D:\\outside')).status).toBe(404);
    expect((await f.list('missing')).status).toBe(404);
    f.session('empty'); f.session('relative', '.'); f.session('outside', 'D:\\unregistered');
    for (const id of ['empty', 'relative', 'outside']) expect((await f.list(id)).status).toBe(400);
    for (const site of ['cross-site', 'same-site']) {
      const request = f.treesRequest(); request.headers.set('sec-fetch-site', site);
      expect((await f.http(request)).status).toBe(400);
    }
    const abort = new AbortController(); abort.abort();
    expect((await f.http(f.treesRequest('sessionId=a', abort.signal))).status).toBe(503);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.listTrees).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    await f.dispose();
  });

  it('并行目录按调用工作区隔离，失败不重试、不泄漏路径也不伪造提交通知', async () => {
    const f = fixture();
    let release!: (value: WorkspaceTreeDirectory) => void;
    f.listTrees.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.list();
    await vi.waitFor(() => expect(f.listTrees).toHaveBeenCalledOnce());
    expect(await (await f.list('b')).json()).toEqual({ ok: true, value: f.directories.get(ROOT_B) });
    release(f.directories.get(ROOT_A)!);
    expect(await (await first).json()).toEqual({ ok: true, value: f.directories.get(ROOT_A) });
    f.listTrees.mockRejectedValueOnce(new Error('D:\\private\\secret.sqlite details'));
    const failure = await f.list();
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ ok: false, error: { code: 'storage', message: '认知树服务暂不可用；请重新读取核对状态。' } });
    expect(f.listTrees).toHaveBeenCalledTimes(3);
    expect(f.call).not.toHaveBeenCalled();
    await f.dispose();
  });

  it('第三条路由注册失败只回滚本次已注册路由，不卸工具或启动后台', async () => {
    const f = fixture({ failRoute: TREES_PATH });
    expect(f.routes.size).toBe(0);
    expect(f.tools.size).toBe(6);
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.factory).not.toHaveBeenCalled();
    await f.dispose();
    expect(f.close).not.toHaveBeenCalled();
  });

  it('第三条路由解绑后拒绝旧handler，已开始读取排空但不返回旧目录且重挂载可恢复', async () => {
    const f = fixture();
    const stale = f.routes.get(TREES_PATH)!;
    let release!: (value: WorkspaceTreeDirectory) => void;
    f.listTrees.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.list();
    await vi.waitFor(() => expect(f.listTrees).toHaveBeenCalledOnce());
    await f.unmount();
    release(f.directories.get(ROOT_A)!);
    expect((await pending).status).toBe(503);
    expect((await stale.fetch(f.treesRequest())).status).toBe(503);
    expect(f.listTrees).toHaveBeenCalledOnce();
    f.connect();
    expect((await f.list('b')).status).toBe(200);
    await f.dispose();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('目录在可信工作区解析及后台冷加载途中解绑都不执行列表读取', async () => {
    const f = fixture();
    let locate!: (value: { path: string }) => void;
    vi.mocked(f.ctx.workspaceRegistry.resolveByPath).mockImplementationOnce(() => new Promise(resolve => { locate = resolve; }));
    const locating = f.list();
    await vi.waitFor(() => expect(locate).toBeTypeOf('function'));
    await f.unmount(); locate({ path: ROOT_A });
    expect((await locating).status).toBe(503);
    expect(f.factory).not.toHaveBeenCalled();
    f.connect();
    let load!: (backend: Backend) => void;
    f.factory.mockImplementationOnce(() => new Promise<Backend>(resolve => { load = resolve; }));
    const loading = f.list();
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
    await f.unmount(); load(f.backend);
    expect((await loading).status).toBe(503);
    expect(f.listTrees).not.toHaveBeenCalled();
    await f.dispose();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it('停用等待已接收的目录读完，与其它请求共用排空且只关闭一次', async () => {
    const f = fixture();
    let release!: (value: WorkspaceTreeDirectory) => void;
    f.listTrees.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = f.list();
    await vi.waitFor(() => expect(f.listTrees).toHaveBeenCalledOnce());
    const closing = f.runtime.close();
    expect(f.close).not.toHaveBeenCalled();
    expect((await f.list('b')).status).toBe(503);
    release(f.directories.get(ROOT_A)!);
    expect((await pending).status).toBe(503); // 后台排空读取，但停用后不再向界面返回旧目录。
    await closing; await f.dispose();
    expect(f.close).toHaveBeenCalledOnce();
  });
});

describe('已提交通知和解绑', () => {
  it('SSE先ready，提交仅进入同工作区的订阅；失败调用不猜测或伪造change', async () => {
    const f = fixture();
    const a = (await f.watch()).body!.getReader();
    const b = (await f.watch('b')).body!.getReader();
    expect(await frame(a)).toContain('event: ready\ndata: {"sessionId":"a"}');
    expect(await frame(b)).toContain('event: ready\ndata: {"sessionId":"b"}');
    f.call.mockRejectedValueOnce(new CognitionError('storage', 'commit failed'));
    expect((await f.post('readNode')).status).toBe(503);
    f.emit(ROOT_A, 2); f.emit(ROOT_B, 3);
    expect(await frame(a)).toContain('event: change\ndata: {"treeId":"T1","stamp":2,"revisions":[]}');
    expect(await frame(b)).toContain('"stamp":3');
    await a.cancel(); await b.cancel();
    await f.dispose();
    expect(f.listeners.size).toBe(0);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('流取消/客户端断线/Connection解绑均释放；重新挂载不留下旧通知或工具', async () => {
    const f = fixture();
    const abort = new AbortController();
    const response = await f.watch('a', abort.signal);
    const reader = response.body!.getReader();
    await frame(reader);
    abort.abort();
    expect(await frame(reader)).toBe('');
    const stale = (await f.watch()).body!.getReader();
    await frame(stale);
    const staleRoute = f.routes.get(CALL_PATH)!;
    await f.unmount();
    expect(await frame(stale)).toBe('');
    expect(f.routes.size).toBe(0);
    expect((await staleRoute.fetch(f.request('readNode'))).status).toBe(503);
    f.connect();
    expect(f.routes.size).toBe(3);
    expect(f.tools.size).toBe(6);
    const staleTool = f.tools.get(AI_TOOLS.readHistory)!;
    const execution = f.exec();
    await f.dispose();
    await expect(staleTool.execute(HISTORY_INPUT, execution)).rejects.toMatchObject({ code: 'storage' });
  });

  it('慢消费者有界断开，不抛回后台；停用不会遗留心跳', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const reader = (await f.watch()).body!.getReader();
      await frame(reader);
      for (let i = 0; i < 25_000; i++) f.emit(ROOT_A, i);
      // 队列中的已发送帧可读完，但内存有界，连接随后结束。
      let count = 0;
      while ((await reader.read()).done === false) count++;
      expect(count).toBeLessThan(25_000);
      expect(vi.getTimerCount()).toBe(0);
      await f.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('订阅只接受单个sessionId，不接受path或重复locator', async () => {
    const f = fixture();
    for (const query of ['sessionId=a&path=x', 'sessionId=a&sessionId=b', 'identity=human', 'sessionId=']) {
      expect((await f.http(new Request(`http://dsh.internal${WATCH_PATH}?${query}`))).status).toBe(400);
    }
    expect(f.factory).not.toHaveBeenCalled();
    await f.dispose();
  });

  it('dispose等已接收调用排空、只close一次，错误不影响其它插件注册项', async () => {
    const f = fixture();
    let settle!: (value: OpOutput[OpName]) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const pending = f.invoke();
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
    const closing = f.runtime.close();
    expect(f.close).not.toHaveBeenCalled();
    settle('committed');
    await expect(pending).resolves.toBe('committed');
    await closing;
    await f.runtime.close();
    await expect(f.invoke()).rejects.toMatchObject({ code: 'storage' });
    expect(f.close).toHaveBeenCalledTimes(1);
    await f.dispose();
  });
});

describe('AI 入口遵循宿主文件策略', () => {
  const addInput = { treeId: 'T1', placement: { parentId: 'N', kind: 'branch' }, draft: { body: { title: 'new' }, state: 'open', refs: [] } };
  const decideInput = { treeId: 'T1', nodeId: 'N', decision: { type: 'prune', reason: 'r', reviveWhen: 'w' } };

  it('显式read-only在worker前拒绝AI写，读和人的owner UI不冒充工具策略', async () => {
    const f = fixture();
    const resolve = vi.fn(() => ({ mode: 'read-only', workspaceRoot: ROOT_A }));
    f.services.set('sandboxPolicy', { resolve });
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.invoke(AI_TOOLS.addBranch, addInput)).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.invoke(AI_TOOLS.decideNode, decideInput)).rejects.toMatchObject({ code: 'invalid' });
    expect(resolve).toHaveBeenLastCalledWith({ session: f.sessions.get('a') });
    expect(f.factory).not.toHaveBeenCalled();
    await expect(f.invoke()).resolves.toBe('result');
    expect((await f.post('createTree', CREATE_INPUT)).status).toBe(200);
    expect(f.calls.map(call => call.actor)).toEqual(['ai', 'human']);
    await f.dispose();
  });

  it('confined缺resolver、未知mode或残缺policy失败关闭，无sandbox的隔离组合和明确danger正常', async () => {
    const f = fixture();
    f.services.set('fs', { sandboxMode: 'workspace-write' });
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).rejects.toMatchObject({ code: 'invalid' });
    f.services.set('sandboxPolicy', { resolve: () => ({ mode: 'future-mode', workspaceRoot: ROOT_A }) });
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).rejects.toMatchObject({ code: 'invalid' });
    f.services.set('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) });
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).rejects.toMatchObject({ code: 'invalid' });
    expect(f.factory).not.toHaveBeenCalled();
    f.services.clear();
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).resolves.toBe(CREATE_INPUT.treeId);
    await expect(f.invoke(AI_TOOLS.addBranch, addInput)).resolves.toBe('result');
    f.services.set('fs', { sandboxMode: 'read-only' });
    f.services.set('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ROOT_A }) });
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).resolves.toBe(CREATE_INPUT.treeId);
    await expect(f.invoke(AI_TOOLS.decideNode, decideInput)).resolves.toBe('result');
    await f.dispose();
  });

  it('workspace-write只准实际policy workspaceRoot内的数据；registry父目录与additional根均不扩大授权', async () => {
    const f = fixture();
    const actual = process.cwd(); // 只读核实既有目录；后台替身从不创建 .converge。
    f.workspaces.set(ROOT_A, actual);
    f.services.set('fs', { sandboxMode: 'workspace-write' });
    f.services.set('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: actual }) });
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).resolves.toBe(CREATE_INPUT.treeId);
    await expect(f.invoke(AI_TOOLS.addBranch, addInput)).resolves.toBe('result');
    f.services.set('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: join(actual, 'src'), additionalWritableRoots: [actual] }) });
    await expect(f.invoke(AI_TOOLS.createTree, CREATE_INPUT)).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.invoke(AI_TOOLS.addBranch, addInput)).rejects.toMatchObject({ code: 'invalid' });
    expect(f.calls).toHaveLength(2);
    expect(containsDataDirectory(ROOT_A, join(ROOT_A, '.converge'))).toBe(true);
    expect(containsDataDirectory(join(ROOT_A, 'sub'), join(ROOT_A, '.converge'))).toBe(false);
    expect(containsDataDirectory(ROOT_A, `${ROOT_A}-sibling\\\\.converge`)).toBe(false);
    expect(containsDataDirectory(ROOT_A, 'C:\\\\other\\\\.converge')).toBe(false);
    await f.dispose();
  });
});

describe('局部故障收敛', () => {
  it('后台创建失败可重试，但不重试未知提交；不泄漏异常堆栈/本地路径', async () => {
    const f = fixture();
    f.factory.mockImplementationOnce(() => { throw new Error('D:\\private\\secret.sqlite internal failure'); });
    await expect(f.invoke()).rejects.toMatchObject({ code: 'storage', message: '认知树服务暂不可用；请重新读取核对状态。' });
    await expect(f.invoke()).resolves.toBe('result');
    f.call.mockRejectedValueOnce(new Error('sensitive detail'));
    const response = await f.post('readNode');
    expect(await response.json()).toEqual({ ok: false, error: { code: 'storage', message: '认知树服务暂不可用；请重新读取核对状态。' } });
    expect(f.call).toHaveBeenCalledTimes(2);
    await f.dispose();
  });

  it('冷加载与停用竞态会解绑迟到后台观察者，不留下订阅或重复close', async () => {
    const f = fixture();
    let release!: (backend: Backend) => void;
    const gate = new Promise<Backend>(resolve => { release = resolve; });
    const lazy = new HostRuntime(f.ctx, () => gate);
    const watching = lazy.subscribe({ root: ROOT_A, change() {}, close() {} });
    const rejected = expect(watching).rejects.toMatchObject({ code: 'storage' });
    const closing = lazy.close();
    release(f.backend);
    await rejected;
    await closing;
    expect(f.listeners.size).toBe(0);
    expect(f.close).toHaveBeenCalledOnce();
    await f.dispose();
  });

  it('Connection在冷订阅建立途中解绑也不产生迟到SSE或心跳', async () => {
    const f = fixture();
    const subscribe = f.runtime.subscribe.bind(f.runtime);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn();
    vi.spyOn(f.runtime, 'subscribe').mockImplementationOnce(async subscriber => { entered(); await gate; return subscribe(subscriber); });
    const watching = f.watch();
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    await f.unmount();
    release();
    expect((await watching).status).toBe(503);
    await f.dispose();
    expect(f.listeners.size).toBe(0);
  });

  it('身份解析失败或请求取消不打开后台', async () => {
    const f = fixture();
    const abort = new AbortController(); abort.abort();
    await expect(workspaceOf(f.ctx, 'a', abort.signal)).rejects.toBeDefined();
    const bad = new HostRuntime(f.ctx, () => { throw new Error('not reached'); });
    await bad.close();
    expect(f.factory).not.toHaveBeenCalled();
    await f.dispose();
  });
});

describe('AI 工具实际回包', () => {
  it('从真实内核读取百节点：保留长 ID 与引用，按紧凑 UTF-8 字节放行和折叠', async () => {
    const f = fixture();
    const epoch = Date.parse('2026-10-20T08:00:00Z');
    let now = epoch;
    const kernel = createKernel({ store: new MemoryTreeStore(), aiViewCost: aiReadViewCost, clock: { now: () => new Date(now).toISOString() } });
    const titles = createT1Seed().nodes.map(n => n.body.title);
    const treeId = 'compact-100';
    try {
      await kernel.dispatch('ai', 'createTree', { treeId, rootQuestion: titles[0] });
      const leaves: string[] = [];
      const editable: string[] = [];
      for (let g = 0; g < 9; g++) {
        const day = epoch + g * 2 * 86400000;
        now = day;
        const parentId = await kernel.dispatch('ai', 'addBranch', { treeId, placement: { parentId: treeId, kind: 'branch' },
          draft: { body: { title: titles[g + 1] }, state: 'open', refs: [] } });
        for (let j = 0; j < 10; j++) {
          now = day + (j < 2 ? 0 : j * 17500 + 31 * j + g);
          const i = 10 * g + j;
          const refs: OpInput['addBranch']['draft']['refs'] = [];
          if (leaves.length && (j === 2 || j === 8)) refs.push({ kind: 'premise', target: { nodeId: leaves.at(-7) ?? leaves[0] } });
          if (j === 8 && g % 3 === 0) refs.push({ kind: 'example', target: { doc: 'research/cognition-events-2026-11-15.md', part: `E${g + 1}` } });
          const state = j === 9 ? 'prune' : j === 0 || i % 3 === 0 ? 'open' : 'keep';
          const id = await kernel.dispatch(i % 13 === 0 ? 'human' : 'ai', 'addBranch', {
            treeId, placement: { parentId, kind: j === 5 && g % 2 === 1 ? 'supplement' : j === 6 && g % 3 === 1 ? 'erratum' : 'branch' },
            draft: { body: { title: titles[(i + 3) % titles.length] }, state, refs,
              ...(state === 'prune' ? { pruneReason: '隔离样本未采用。', reviveWhen: '前提改变时重看。' } : {}) },
          });
          leaves.push(id);
          if (j === 0) editable.push(id);
        }
      }
      for (const [i, nodeId] of editable.entries()) {
        now += 3021;
        await kernel.dispatch(i % 2 ? 'ai' : 'human', 'decideNode', { treeId, nodeId, decision: { type: 'setOpenOrKeep', state: 'keep', reason: '隔离样本的后续修订。' } });
        if (i % 3 === 0) {
          const revisionId = (await kernel.dispatch('human', 'readNode', { treeId, nodeId })).node.currentChange!.revisionId;
          await kernel.dispatch('human', 'confirm', { treeId, target: { revisionId } });
        }
      }
      f.call.mockImplementation(async (_root, actor, op, input) => {
        if (actor !== 'ai' && actor !== 'human') throw new Error('隔离测试的调用身份无效。');
        return kernel.dispatch(actor, op, input);
      });
      const tool = f.tools.get(AI_TOOLS.readView)!;
      const base: OpInput['readView'] = { treeId, focus: { root: true }, onLimit: 'exact',
        expand: { subtreeDepth: 'leaf', jumpHops: 0, direction: 'both', jumpFrom: 'expanded', afterJumpDepth: 0 },
        budget: { maxScans: 1000, maxNodes: 100, maxBytes: 32000 } };

      /** 走实际工具的 execute 与 render，统计真正交给模型的正文。@param input 已明确预算的查询。 */
      async function read(input: OpInput['readView']) {
        const view = await tool.execute(input, f.exec()) as OpOutput['readView'];
        const text = tool.output.render(input, view)[0].text;
        const bytes = Buffer.byteLength(text, 'utf8');
        expect(text.startsWith('CTV2 ')).toBe(true);
        expect(bytes).toBeLessThanOrEqual(input.budget.maxBytes);
        return { view, text, bytes };
      }
      /** 首次命中标题、状态和确认的原始字节；连接点与重复项不计信号。@param page 当前页。@param seen 同一读路径已计入的命中 ID。 */
      function signalBytes(page: OpOutput['readView'], seen: Set<string>) {
        let signal = 0;
        for (const node of page.nodes) {
          if (node.role !== 'hit' || seen.has(node.id)) continue;
          seen.add(node.id);
          signal += Buffer.byteLength(node.title) + Buffer.byteLength(node.state ?? '') + Buffer.byteLength(node.confirmation ?? '');
        }
        return signal;
      }
      const sample = await read(base);
      expect(sample.view.nodes).toHaveLength(100);
      expect(sample.view.complete).toBe(true);
      expect(sample.view.boundaries).toHaveLength(100);
      const signal = signalBytes(sample.view, new Set());
      const raw = Buffer.byteLength(JSON.stringify(sample.view));
      const tight = { ...base, budget: { ...base.budget, maxBytes: sample.bytes + 32 } };
      expect(tight.budget.maxBytes).toBeLessThan(raw);
      expect((await read(tight)).text).toBe(sample.text);
      const human = await (await f.post('readView', tight)).json();
      expect(human).toMatchObject({ ok: false, error: { code: 'rangeTooLarge' } });
      const humanDetail = await kernel.dispatch('human', 'readNode', { treeId, nodeId: leaves[0] });
      const detailInput = { treeId, focus: leaves[0], onLimit: 'exact' as const,
        expand: { subtreeDepth: 0, jumpHops: 0, direction: 'both' as const, jumpFrom: 'anchor' as const, afterJumpDepth: 0 },
        budget: { maxScans: 400, maxNodes: 8, maxBytes: 32000 }, includeDetails: true };
      const detailPage = await tool.execute(detailInput, f.exec()) as OpOutput['readView'];
      const detailNode = detailPage.nodes.find(node => node.id === leaves[0])!;
      expect(detailNode.detail).toEqual(humanDetail);
      expect(detailPage.nodes.every(node => node.detail !== undefined)).toBe(true);
      const detailText = tool.output.render(detailInput, detailPage)[0].text;
      expect(detailText).toBe(JSON.stringify(detailPage));
      expect(detailText.startsWith('CTV2 ')).toBe(false);

      const withRefs = await read({ ...base, expand: { ...base.expand, jumpHops: 1 } });
      expect(withRefs.view.refs).toHaveLength(21);
      const seen = new Set<string>();
      let cursor: string | undefined;
      let totalFoldBytes = 0;
      let foldSignal = 0;
      let pages = 0;
      do {
        expect(pages).toBeLessThan(20);
        const next = await read({ ...base, onLimit: 'fold', budget: { maxScans: 400, maxNodes: 50, maxBytes: 4000 }, ...(cursor ? { cursor } : {}) });
        expect(next.view.stamp).toBe(sample.view.stamp);
        if (!next.view.complete) expect(next.view.boundaries.some(b => b.kind === 'budget')).toBe(true);
        totalFoldBytes += next.bytes;
        foldSignal += signalBytes(next.view, seen);
        pages++;
        cursor = next.view.cursor;
      } while (cursor);
      expect(seen.size).toBe(100);
      expect(foldSignal).toBe(signal);
      const noise = (sample.bytes - signal) / sample.bytes;
      console.info('CTV2 真实内核与工具回包：100 个长 ID', {
        raw, signal, compact: sample.bytes, noise,
        withRefs: { bytes: withRefs.bytes, edges: withRefs.view.refs.length, noise: (withRefs.bytes - signal) / withRefs.bytes },
        folded: { bytes: totalFoldBytes, pages, noise: (totalFoldBytes - signal) / totalFoldBytes },
      });
      expect(noise).toBeLessThan(0.25);
    } finally { await f.dispose(); }
  });
});

describe('AI 读取预算默认值与工具说明', () => {
  const VIEW_INPUT = {
    treeId: 'T1',
    focus: { root: true as const },
    expand: { subtreeDepth: 1, jumpHops: 0, direction: 'both' as const, jumpFrom: 'anchor' as const, afterJumpDepth: 1 },
    onLimit: 'fold' as const,
  };
  const DEFAULT_BUDGET = { maxScans: 400, maxNodes: 24, maxBytes: 4000 };

  it('隔离 T1 同题对照：使用默认预算，仍能找齐「为什么不用纯树」的依据', async () => {
    const f = fixture();
    try {
      const kernel = createKernel({ store: new MemoryTreeStore(), clock: { now: () => '2026-11-20T00:00:00Z' } });
      await kernel.dispatch('human', 'bootstrapTree', { seed: createT1Seed() });
      f.call.mockImplementation(async (_root, actor, op, input) => {
        if (actor !== 'ai' && actor !== 'human') throw new Error('隔离测试的调用身份无效');
        return kernel.dispatch(actor, op, input);
      });
      const query = { ...VIEW_INPUT, expand: { ...VIEW_INPUT.expand, subtreeDepth: 3 } };

      /**
       * 固定同一取证路径，按模型正文的 JSON 字节计量，不用标题长度代理上下文。
       * @param view 读取下一页的入口。
       * @param detail 按节点 ID 读取详情的入口；AI 侧用 readView 的详情模式。
       */
      async function replay(
        view: (cursor?: string) => Promise<OpOutput['readView']>,
        detail: (nodeId: string) => Promise<NodeDetail>,
      ) {
        const pages: OpOutput['readView'][] = [];
        let cursor: string | undefined;
        for (let n = 0; n < 8; n++) {
          const p = await view(cursor);
          pages.push(p);
          cursor = p.cursor;
          if (p.complete) break;
          expect(cursor).toBeDefined();
        }
        expect(pages.at(-1)?.complete).toBe(true);
        const hits = pages.flatMap((p) => p.nodes.filter((node) => node.role === 'hit'));
        const pure = hits.find((node) => node.title === '纯树');
        const chosen = hits.find((node) => node.title === '树 + 有类型引用边');
        expect(pure?.state).toBe('prune');
        expect(chosen?.state).toBe('keep');
        const grounds = await Promise.all([pure!.id, chosen!.id].map((id) => detail(id)));
        const viewBytes = pages.reduce((n, page) => n + Buffer.byteLength(JSON.stringify(page)), 0);
        const totalBytes = grounds.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item)), viewBytes);
        return { grounds, report: { calls: pages.length + grounds.length, viewPages: pages.length, viewBytes, totalBytes } };
      }

      /** AI 取单节点详情的唯一路径：以该 ID 为 focus 读详情页，不依赖已撤掉的点查工具。 */
      async function aiDetail(nodeId: string): Promise<NodeDetail> {
        const page = await f.invoke(AI_TOOLS.readView, {
          treeId: query.treeId, focus: nodeId, onLimit: 'exact',
          expand: { subtreeDepth: 0, jumpHops: 0, direction: 'both', jumpFrom: 'anchor', afterJumpDepth: 0 },
          budget: { maxScans: 400, maxNodes: 16, maxBytes: 65536 }, includeDetails: true,
        }) as OpOutput['readView'];
        expect(page.nodes.every(node => node.detail !== undefined)).toBe(true);
        const node = page.nodes.find(item => item.id === nodeId);
        expect(node?.detail).toBeDefined();
        return node!.detail!;
      }

      // 同一快照和范围；旧形状用显式的宽字节预算装下全量标记。人侧完整投影是对照，不访问当前 DSH。
      const full = await replay(
        (cursor) => kernel.dispatch('human', 'readView', { ...query, budget: { ...DEFAULT_BUDGET, maxBytes: 8000 }, ...(cursor ? { cursor } : {}) }),
        (nodeId) => kernel.dispatch('human', 'readNode', { treeId: query.treeId, nodeId }),
      );
      const compact = await replay(
        (cursor) => f.invoke(AI_TOOLS.readView, { ...query, ...(cursor ? { cursor } : {}) }) as Promise<OpOutput['readView']>,
        (nodeId) => aiDetail(nodeId),
      );
      expect(compact.grounds).toEqual(full.grounds);
      expect(compact.grounds[0]?.node.pruneReason).toContain('共享前提、同类实例、与事实冲突');
      expect(compact.grounds[0]?.node).not.toHaveProperty('reviveWhen');
      expect(compact.grounds[1]?.node.body.basis).toContain('跨边真实存在但较稀疏');
      expect(compact.report.calls).toBeLessThanOrEqual(full.report.calls);
      expect(compact.report.totalBytes).toBeLessThan(full.report.totalBytes);
      expect(f.call).toHaveBeenCalledTimes(compact.report.calls);
      console.info('T1 固定取证路径（隔离宿主；JSON UTF-8 字节）', { full: full.report, compact: compact.report });
    } finally { await f.dispose(); }
  });

  it('撤掉 AI 单点入口后人侧 /call 的 readNode 仍读取真实内核详情', async () => {
    const f = fixture();
    try {
      const kernel = createKernel({ store: new MemoryTreeStore(), clock: { now: () => '2026-11-20T00:00:00Z' } });
      await kernel.dispatch('human', 'bootstrapTree', { seed: createT1Seed() });
      f.call.mockImplementation(async (_root, actor, op, input) => {
        if (actor !== 'ai' && actor !== 'human') throw new Error('隔离测试的调用身份无效');
        return kernel.dispatch(actor, op, input);
      });
      const response = await f.post('readNode', { treeId: 'T1', nodeId: 'T1.1' });
      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean; value?: OpOutput['readNode'] };
      expect(body.ok).toBe(true);
      expect(body.value?.node.id).toBe('T1.1');
      expect(body.value?.node.body.title).toBe('对话树：按对话过程组织');
      expect(f.call).toHaveBeenCalledWith(ROOT_A, 'human', 'readNode', { treeId: 'T1', nodeId: 'T1.1' });
    } finally { await f.dispose(); }
  });

  it('AI readView 仅在整项省略 budget 时注入三项默认，内核收到显式三项', async () => {
    const f = fixture();
    await f.invoke(AI_TOOLS.readView, VIEW_INPUT);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ root: ROOT_A, actor: 'ai', op: 'readView' });
    const sent = f.calls[0]!.input as unknown as { budget: Record<string, unknown> };
    expect(sent.budget).toEqual(DEFAULT_BUDGET);
    expect(Object.keys(sent.budget)).toEqual(['maxScans', 'maxNodes', 'maxBytes']);
    await f.dispose();
  });

  it('显式 budget（不同值、null、缺项、非法）原样交给内核，不补默认也不吞错', async () => {
    const explicit: unknown[] = [
      { maxScans: 9, maxNodes: 3, maxBytes: 100 },
      null,
      {},
      { maxScans: 0 },
      { maxScans: 0, maxNodes: -1, maxBytes: 1.5 },
    ];
    const f = fixture();
    for (const budget of explicit) await f.invoke(AI_TOOLS.readView, { ...VIEW_INPUT, budget });
    expect(f.calls.map(call => (call.input as unknown as { budget: unknown }).budget)).toEqual(explicit);
    // 省略 budget 仍不能夹带身份、路径或未知字段。
    await expect(f.invoke(AI_TOOLS.readView, { ...VIEW_INPUT, budget: undefined, actor: 'human' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.invoke(AI_TOOLS.readView, { ...VIEW_INPUT, sessionId: 'b' })).rejects.toMatchObject({ code: 'invalid' });
    expect(f.calls).toHaveLength(explicit.length);
    await f.dispose();
  });

  it('人侧 readView 的 budget 仍必传，显式值不被 AI 默认替换', async () => {
    const f = fixture();
    expect((await f.post('readView', VIEW_INPUT)).status).toBe(400);
    expect(f.call).not.toHaveBeenCalled();
    const budget = { maxScans: 7, maxNodes: 2, maxBytes: 512 };
    expect(await (await f.post('readView', { ...VIEW_INPUT, budget })).json()).toEqual({ ok: true, value: 'result' });
    expect(f.calls).toEqual([{ root: ROOT_A, actor: 'human', op: 'readView', input: { ...VIEW_INPUT, budget } }]);
    await f.dispose();
  });

  /** 递归收集缺少中文说明的 schema 节点；参数说明只检查字段/分支，不要求根对象自述。 */
  function missingDescriptions(schema: JsonSchema, path: string): string[] {
    const missing: string[] = [];
    if (!schema.description?.trim() || !/[\u4e00-\u9fff]/.test(schema.description)) missing.push(path);
    for (const [key, child] of Object.entries(schema.properties ?? {})) missing.push(...missingDescriptions(child, `${path}.${key}`));
    for (const [index, branch] of (schema.oneOf ?? []).entries()) missing.push(...missingDescriptions(branch, `${path}<${index}>`));
    if (schema.items) missing.push(...missingDescriptions(schema.items, `${path}[]`));
    return missing;
  }

  it('六个工具的参数、嵌套字段与二选一分支都有中文说明，readView 合同写明单位与续读规则', async () => {
    const f = fixture();
    for (const tool of f.tools.values()) {
      expect(tool.description).toContain('当前工作区');
      const gaps = Object.entries(tool.parameters.properties ?? {})
        .flatMap(([key, child]) => missingDescriptions(child, `${tool.name}.${key}`));
      expect(gaps).toEqual([]);
    }
    const view = f.tools.get(AI_TOOLS.readView)!;
    expect(view.parameters.required).toEqual(['treeId', 'focus', 'expand', 'onLimit']);
    const budget = view.parameters.properties!.budget!;
    expect(budget.required).toEqual(['maxScans', 'maxNodes', 'maxBytes']);
    expect(budget.description).toContain('maxScans:400');
    expect(budget.description).toContain('省略整个 budget');
    expect(budget.description).toContain('null');
    expect(budget.properties!.maxScans!.description).toContain('次');
    expect(budget.properties!.maxNodes!.description).toContain('个');
    expect(budget.properties!.maxBytes!.description).toContain('UTF-8 字节');
    expect(view.parameters.properties!.expand!.properties!.jumpHops!.description).toContain('refs/scope');
    expect(view.parameters.properties!.expand!.properties!.jumpHops!.description).toContain('不代表查尽');
    expect(view.parameters.properties!.cursor!.description).toContain('同范围同策略');
    expect(view.parameters.properties!.cursor!.description).toContain('includeDetails');
    expect(view.parameters.properties!.cursor!.description).toContain('预算可按本页重新给出');
    await f.dispose();
  });
});

describe('AI 详情读取的注册参数与输出', () => {
  const VIEW_INPUT = {
    treeId: 'T1',
    focus: { root: true as const },
    expand: { subtreeDepth: 'leaf' as const, jumpHops: 0, direction: 'both' as const, jumpFrom: 'anchor' as const, afterJumpDepth: 0 },
    onLimit: 'fold' as const,
  };
  const DEFAULT_BUDGET = { maxScans: 400, maxNodes: 24, maxBytes: 4000 };
  const ROOT_ID = 'node-rev-1700000000000-0000000000000001';
  const CHILD_ID = 'node-rev-1700000001000-0000000000000001';
  const REVISION_ID = 'rev-1700000001000-0000000000000001';

  /** 详情页节点：ViewNode 加一个 NodeDetail，link 父链也带 detail。 */
  type DetailedNode = ViewNode & { detail: NodeDetail };
  type DetailedView = Omit<TreeView, 'nodes'> & { nodes: DetailedNode[] };

  /** 一页最小详情视图；根是连通父链 link，子节点是命中。 */
  function detailedView(): DetailedView {
    const rootDetail: NodeDetail = {
      node: { id: ROOT_ID, parentId: null, body: { title: '根问题' }, origin: { kind: 'branch' } },
    };
    const childDetail: NodeDetail = {
      node: {
        id: CHILD_ID, parentId: ROOT_ID, body: { title: '子判断', text: '展开正文', basis: '依据' },
        state: 'keep', confirmation: 'humanConfirmed', origin: { kind: 'branch' },
        currentChange: { revisionId: REVISION_ID, by: 'human' },
      },
      currentChange: {
        id: REVISION_ID, kind: 'formation', at: '2026-11-20T00:00:00Z', nodeIds: [CHILD_ID],
        summary: '人确认前的形成记录', by: 'human',
        detail: { action: 'addBranch', effects: [{ nodeId: CHILD_ID, afterState: 'keep' }] },
      },
    };
    return {
      rootId: ROOT_ID, focusId: CHILD_ID,
      nodes: [
        { id: ROOT_ID, parentId: null, title: '根问题', origin: { kind: 'branch' }, role: 'link', detail: rootDetail },
        {
          id: CHILD_ID, parentId: ROOT_ID, title: '子判断', state: 'keep', confirmation: 'humanConfirmed',
          origin: { kind: 'branch' }, role: 'hit', currentChange: { revisionId: REVISION_ID, by: 'human' }, detail: childDetail,
        },
      ],
      refs: [], boundaries: [{ nodeId: CHILD_ID, axis: 'children', kind: 'exhausted' }], complete: true, stamp: 42,
    };
  }

  /** 同一页去掉 detail 的普通视图，用于核对缺省表示未变。 */
  function plainView(): TreeView {
    return {
      rootId: ROOT_ID, focusId: CHILD_ID,
      nodes: [
        { id: ROOT_ID, parentId: null, title: '根问题', origin: { kind: 'branch' }, role: 'link' },
        {
          id: CHILD_ID, parentId: ROOT_ID, title: '子判断', state: 'keep', confirmation: 'humanConfirmed',
          origin: { kind: 'branch' }, role: 'hit', currentChange: { revisionId: REVISION_ID, by: 'human' },
        },
      ],
      refs: [], boundaries: [{ nodeId: CHILD_ID, axis: 'children', kind: 'exhausted' }], complete: true, stamp: 42,
    };
  }

  it('注册可选布尔 includeDetails 并原样透传，不改变默认预算与 CTV2 缺省表示', async () => {
    const f = fixture();
    try {
      const tool = f.tools.get(AI_TOOLS.readView)!;
      expect(tool.parameters.required).toEqual(['treeId', 'focus', 'expand', 'onLimit']);
      const field = tool.parameters.properties!.includeDetails!;
      expect(field.type).toBe('boolean');
      expect(field.description).toContain('detail');
      expect(field.description).toContain('CTV2');
      expect(field.description).toContain('false');
      expect(tool.description).toContain('includeDetails=true');
      expect(tool.description).toContain('完整 JSON');
      // 撤掉 AI 点查后，详情只能由 read_view 以该 ID 为 focus 取得；描述不得再提 read_node。
      expect(tool.description).toContain('focus');
      expect(tool.description).not.toContain('read_node');

      await f.invoke(AI_TOOLS.readView, VIEW_INPUT);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.input).not.toHaveProperty('includeDetails');
      expect((f.calls[0]!.input as unknown as { budget: unknown }).budget).toEqual(DEFAULT_BUDGET);

      f.calls.length = 0;
      await f.invoke(AI_TOOLS.readView, { ...VIEW_INPUT, includeDetails: true });
      expect(f.calls[0]!.input).toMatchObject({ includeDetails: true });
      expect((f.calls[0]!.input as unknown as { budget: unknown }).budget).toEqual(DEFAULT_BUDGET);
      await expect(f.invoke(AI_TOOLS.readView, { ...VIEW_INPUT, details: true })).rejects.toMatchObject({ code: 'invalid' });

      // 白名单由人侧 /call 与 AI 工具共享；详细标记只透传，工作区与身份仍由宿主绑定。
      const budget = { maxScans: 7, maxNodes: 2, maxBytes: 512 };
      expect(await (await f.post('readView', { ...VIEW_INPUT, budget, includeDetails: true })).json())
        .toEqual({ ok: true, value: 'result' });
      expect(f.calls.at(-1)!.input).toEqual({ ...VIEW_INPUT, budget, includeDetails: true });
    } finally { await f.dispose(); }
  });

  it('详情页按原样 JSON 输出，字节精确，link 父链的 detail 不丢', async () => {
    const f = fixture();
    try {
      const view = detailedView();
      f.call.mockResolvedValue(view as unknown as OpOutput[OpName]);
      const args = { ...VIEW_INPUT, includeDetails: true };
      const value = await f.invoke(AI_TOOLS.readView, args);
      const text = f.tools.get(AI_TOOLS.readView)!.output.render(args, value)[0]!.text;
      expect(text).toBe(JSON.stringify(view));
      expect(Buffer.byteLength(text, 'utf8')).toBe(Buffer.byteLength(JSON.stringify(view), 'utf8'));
      expect(text.startsWith('CTV2 ')).toBe(false);
      const page = JSON.parse(text) as DetailedView;
      expect(page).toEqual(view);
      expect(page.nodes.map(node => node.role)).toEqual(['link', 'hit']);
      expect(page.nodes[0]!.detail.node.body.title).toBe('根问题');
      expect(page.nodes[1]!.detail.currentChange?.summary).toBe('人确认前的形成记录');
      // 回包已带 detail 时即使参数未标详情，也不能退回丢字段的 CTV2。
      expect(f.tools.get(AI_TOOLS.readView)!.output.render(VIEW_INPUT, value)[0]!.text).toBe(text);
    } finally { await f.dispose(); }
  });

  it('缺省与显式 false 仍输出同一份 CTV2 文本', async () => {
    const f = fixture();
    try {
      const tool = f.tools.get(AI_TOOLS.readView)!;
      const view = plainView();
      const omitted = tool.output.render(VIEW_INPUT, view)[0]!.text;
      const explicitFalse = tool.output.render({ ...VIEW_INPUT, includeDetails: false }, view)[0]!.text;
      expect(omitted.startsWith('CTV2 ')).toBe(true);
      expect(explicitFalse).toBe(omitted);
    } finally { await f.dispose(); }
  });

  it('真实内核详情页：命中与 link 父链都带 detail，工具按原样 JSON 交付', async () => {
    const f = fixture();
    try {
      const kernel = createKernel({
        store: new MemoryTreeStore(), aiViewCost: aiReadViewCost, clock: { now: () => '2026-11-20T00:00:00Z' },
      });
      await kernel.dispatch('human', 'bootstrapTree', { seed: createT1Seed() });
      f.call.mockImplementation(async (_root, actor, op, input) => {
        if (actor !== 'ai' && actor !== 'human') throw new Error('隔离测试的调用身份无效');
        return kernel.dispatch(actor, op, input);
      });
      const tool = f.tools.get(AI_TOOLS.readView)!;
      const args = {
        treeId: 'T1', focus: 'T1.3.3.2',
        expand: { subtreeDepth: 1, jumpHops: 0, direction: 'both' as const, jumpFrom: 'anchor' as const, afterJumpDepth: 0 },
        budget: { maxScans: 500, maxNodes: 20, maxBytes: 60000 }, onLimit: 'exact' as const,
        includeDetails: true,
      };
      const value = await tool.execute(args, f.exec()) as OpOutput['readView'];
      expect(value.nodes.every(node => node.detail !== undefined)).toBe(true);
      expect(value.nodes.some(node => node.role === 'link')).toBe(true);
      const text = tool.output.render(args, value)[0]!.text;
      expect(text).toBe(JSON.stringify(value));
      expect(text.startsWith('CTV2 ')).toBe(false);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(args.budget.maxBytes);

      // 同一范围不带详情时仍是轻量页和 CTV2，缺省表示不因详情模式出现而改变。
      const compactArgs = { ...args, includeDetails: false };
      const compact = await tool.execute(compactArgs, f.exec()) as OpOutput['readView'];
      expect(compact.nodes.every(node => node.detail === undefined)).toBe(true);
      const compactText = tool.output.render(compactArgs, compact)[0]!.text;
      expect(compactText.startsWith('CTV2 ')).toBe(true);
      expect(compactText).toBe(tool.output.render({ ...args, includeDetails: undefined }, compact)[0]!.text);
    } finally { await f.dispose(); }
  });
});
