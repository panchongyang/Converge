/**
 * check-host 的隔离宿主装配：真实 SDK 模块、宿主服务替身、内存 Fetch 与夹具。
 *
 * 职责：按本机 DSH checkout 的公开包入口解析真实 Cordis/Tools/Connection 模块；
 * 提供 sessions/workspaceRegistry/sessionPersistence 的接口翻译替身；在内存中
 * 分发 exact Fetch 路由，并构造无关工具/路由与存盘业务输入。
 * 边界：不启动端口、不读写用户 profile；替身只回答宿主绑定的最小事实。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 以公开包入口解析的模块；不深入 lib 私有路径。 */
const SDK_PACKAGES = {
  cordis: '@deepseek-ai/cordis',
  tools: '@deepseek-ai/dsh-tools',
  systemPrompt: '@deepseek-ai/dsh-system-prompt',
  connection: '@deepseek-ai/dsh-client-connection',
};

/**
 * 找到文件最近的 package.json，用于报告真实版本而不猜目录。
 * @param file 包入口绝对路径
 * @returns 最近的 package.json 绝对路径
 */
function nearestPackageJson(file) {
  let current = dirname(file);
  for (;;) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) throw new Error(`无法为 ${file} 定位 package.json`);
    current = parent;
  }
}

/**
 * 从 SDK checkout 的依赖根解析并导入真实公开模块。
 * @param sdkRoot DSH 服务 checkout（包含 node_modules）
 * @returns 模块、包版本及解析到的入口路径
 */
export async function loadSdk(sdkRoot) {
  const requireFromSdk = createRequire(join(sdkRoot, 'package.json'));
  const modules = {};
  const entries = {};
  const versions = {};
  for (const [key, specifier] of Object.entries(SDK_PACKAGES)) {
    const entry = requireFromSdk.resolve(specifier);
    entries[key] = entry;
    const pkg = JSON.parse(readFileSync(nearestPackageJson(entry), 'utf8'));
    versions[key] = { name: pkg.name, version: pkg.version };
    modules[key] = await import(pathToFileURL(entry).href);
  }
  const dshEntry = requireFromSdk.resolve('@deepseek-ai/dsh/package.json');
  const dshPkg = JSON.parse(readFileSync(dshEntry, 'utf8'));
  return {
    Context: modules.cordis.Context,
    Service: modules.cordis.Service,
    SystemPrompt: modules.systemPrompt.SystemPrompt,
    ToolsService: modules.tools.ToolsService,
    HostConnectionService: modules.connection.HostConnectionService,
    versions: { ...versions, dsh: { name: dshPkg.name, version: dshPkg.version } },
    entries,
  };
}

/**
 * 在仓库 .local-work 下创建本次运行独有的夹具目录与会话事实。
 * @param repoRoot 仓库根绝对路径
 * @returns 运行目录、工作区根、宿主会话与唯一树 ID
 */
export function makeFixture(repoRoot) {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const suffix = randomBytes(4).toString('hex');
  const runId = `${stamp}-${suffix}`;
  const runDir = join(repoRoot, '.local-work', 'dsh-host-check', runId);
  const workspace = join(runDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const otherWorkspace = join(runDir, 'other-workspace');
  mkdirSync(otherWorkspace);
  return {
    otherWorkspace,
    peerSession: { id: `sess-peer-${suffix}`, header: { cwd: workspace } },
    otherSession: { id: `sess-other-${suffix}`, header: { cwd: otherWorkspace } },
    runId,
    runDir,
    workspace,
    session: { id: `sess-check-${suffix}`, header: { cwd: workspace } },
    treeId: `T-check-${suffix}`,
  };
}

/**
 * 安装 sessions / workspaceRegistry / sessionPersistence 的接口翻译替身。
 *
 * 三者真实实现会读写 DSH profile 或持久化日志；这里只按夹具回答宿主已绑定的事实，
 * 让插件的 workspaceOf 校验走真实代码路径，而不冒充真实 registry 的规范化与持久化。
 * @param ctx 真实 Cordis 根上下文
 * @param Service Cordis Service 基类
 * @param fixture makeFixture 的返回值
 * @returns 三个替身实例
 */
export function installHostDoubles(ctx, Service, fixture) {
  const sessions = new Map([fixture.session, fixture.peerSession, fixture.otherSession].map(session => [session.id, session]));
  class SessionsDouble extends Service {
    /** @param context 宿主上下文 */
    constructor(context) { super(context, 'sessions'); }
    /**
     * @param id 会话定位符
     * @returns 仅夹具会话可见
     */
    get(id) { return sessions.get(id); }
  }
  class WorkspaceRegistryDouble extends Service {
    /** @param context 宿主上下文 */
    constructor(context) { super(context, 'workspaceRegistry'); }
    /**
     * 按窗口大小写不敏感地承认夹具工作区，其它路径一律未绑定。
     * @param input 宿主会话 header 中的绝对 cwd
     * @returns 已注册工作区或 undefined
     */
    async resolveByPath(input) {
      if (typeof input !== 'string' || !input) return undefined;
      const key = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      const workspace = [fixture.workspace, fixture.otherWorkspace].find(path => key(input) === key(path));
      return workspace ? { path: workspace } : undefined;
    }
  }
  class SessionPersistenceDouble extends Service {
    /** @param context 宿主上下文 */
    constructor(context) { super(context, 'sessionPersistence'); }
    /**
     * @param id 会话定位符
     * @returns 夹具会话的持久化头部视图
     */
    async stat(id) {
      const session = sessions.get(id);
      return session ? { header: session.header } : undefined;
    }
  }
  return {
    sessions: new SessionsDouble(ctx),
    workspaces: new WorkspaceRegistryDouble(ctx),
    persistence: new SessionPersistenceDouble(ctx),
  };
}

/**
 * HostConnectionService 构造所需的浏览器认证替身。
 *
 * 本检查不经过 HTTP 载体，而是用 Connection 已认证 owner peer 直接调用共享 Fetch
 * handler；因此不实现 cookie/launch token，也不读取或打印任何凭证。
 * @returns 只满足构造签名的方法集合
 */
export function makeBrowserAuthDouble() {
  return {
    isAuthenticated() { return false; },
    authenticateApi() { return undefined; },
    authorizeIndex() { return false; },
    authorizeConnect() {},
    authenticatedUrl(url) { return url; },
  };
}

/**
 * 用真实 HostConnectionService 组合出的共享 handler 做内存分发。
 * @param connection 真实 HostConnectionService
 * @returns (path, init) => Promise<Response>
 */
export function createDispatcher(connection) {
  const handler = connection.createSharedFetchHandler('/api');
  const peer = connection.browserPeer;
  return (path, init = {}) => handler.fetch(
    new Request(new URL(path, 'http://127.0.0.1:3080'), init),
    peer,
  );
}

/** 无关路由的响应标记；插件若改写 /api fallback 会破坏它。 */
export const PROBE_PATH = '/api/cognition-check/probe';

/**
 * 构造一个经由真实 Fetch 注册表登记、与认知树无关的 exact 路由。
 * @returns ConnectionFetchRoute 形状的探测路由
 */
export function probeRoute() {
  return {
    path: PROBE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      return new Response(JSON.stringify({ ok: true, marker: 'host-probe', method: request.method }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  };
}

/** 无关工具名；与认知树工具同时存在于真实 ToolsService。 */
export const PROBE_TOOL = 'cognition_check_probe';

/**
 * 构造一个经由真实 ToolsService 登记、与认知树无关的工具定义。
 * @returns 原始 JSON Schema 的工具定义
 */
export function probeTool() {
  return {
    name: PROBE_TOOL,
    description: '隔离宿主检查用的无关工具；不读写认知树。',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) { return `probe:${args.value}`; },
  };
}

/**
 * 构造旧客户端可能提交的种子，用于验证即使 schema 有效也不能通过 DSH 导入。
 * @param treeId 本次运行唯一的树 ID
 * @returns bootstrapTree 可接受的 SeedTree
 */
export function seedTree(treeId) {
  return {
    treeId,
    rootId: 'T1',
    nodes: [{
      id: 'T1',
      parentId: null,
      body: { title: '隔离宿主检查根', text: '由 check-host 在真实 worker/SQLite 中创建。' },
      origin: { kind: 'branch' },
      state: 'keep',
      confirmation: 'unconfirmed',
    }],
    refs: [],
    history: [],
  };
}

/**
 * 构造根焦点、无跳转的只读视图参数。
 * @param treeId 本次运行唯一的树 ID
 * @returns readView 输入
 */
export function readViewInput(treeId) {
  return {
    treeId,
    focus: { root: true },
    expand: { subtreeDepth: 2, jumpHops: 0, direction: 'out', jumpFrom: 'anchor', afterJumpDepth: 1 },
    budget: { maxScans: 1000, maxNodes: 1000, maxBytes: 262_144 },
    onLimit: 'fold',
  };
}

/**
 * 读取一个 JSON 路由响应；非 JSON 时附带文本摘要便于定位。
 * @param response Fetch 响应
 * @returns 解析后的 JSON
 */
export async function responseJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { __text: text }; }
}

/**
 * 轮询直到条件成立或超时。
 * @param predicate 条件函数
 * @param timeoutMs 最长等待
 * @param label 失败信息
 * @returns 条件最后一次返回值
 */
export async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`等待超时：${label}`);
}
