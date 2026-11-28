/**
 * 已安装 DSH 0.2.2-rc.1 的最小结构契约；不加载 SDK、profile 或宿主服务。
 * 对照 dsh-tools/lib/types/contracts、dsh-client-connection/lib/types/rpc、
 * dsh-session/lib/types/index 与 dsh-workspace/lib/types/index；隔离 ABI 测试使用真实实现。
 */
export interface SessionIdentity {
  readonly id: string;
  readonly header: { readonly cwd?: string };
}

/** DSH 注册表接收的随包技能；省略 invocation 即允许模型与人的原生调用面。 */
export interface BundledSkill {
  readonly source: 'bundled';
  readonly provider: 'dsh-cognition-tree';
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly content: string;
}

export type Dispose = () => void | Promise<void>;
export interface AgentSkills { register(skill: BundledSkill): Dispose }

/** 只使用宿主发出的精确 agent 对象和 agent-local Context，不从会话 ID 反推作用域。 */
export interface HostAgent {
  readonly id: string;
  readonly session: SessionIdentity;
  readonly ctx?: {
    get(name: 'skills'): AgentSkills | undefined;
    get(name: 'tools'): { register(tool: HostTool): Dispose } | undefined;
  };
}

/** 只取宿主执行器已经绑定的 agent/session，不接受工具参数自报身份。 */
export interface ToolExecution {
  readonly agent?: HostAgent;
  readonly signal: AbortSignal;
}

/** DSH 支持的原始 JSON Schema 子集；不依赖 SDK 的运行时 schema DSL。 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  description?: string;
}

/** execute 返回 canonical JSON；output.render 才负责翻译成模型正文。 */
export interface HostTool {
  name: string;
  description: string;
  parameters: JsonSchema & { type: 'object' };
  output: {
    schema: JsonSchema;
    render(args: unknown, value: unknown): { type: 'text'; text: string }[];
    presentationMeta?(args: unknown, value: unknown): unknown;
  };
  execute(args: unknown, exec: ToolExecution): Promise<unknown>;
}

/** 认证与 owner 检查属于 Connection；插件只注册 exact 路由，不占 /api fallback。 */
export interface FetchRoute {
  path: string;
  methods: readonly ('GET' | 'HEAD' | 'POST')[];
  requestBody: 'buffered' | 'streaming';
  fetch(request: Request): Promise<Response>;
}

/** 插件只读取现有宿主服务；不会创建或替换它们。 */
export interface HostContext {
  /** 可选宿主能力只经 get 读取；缺失不得被猜成授予写权限。 */
  get(name: 'sandboxPolicy' | 'fs' | 'sessionPersistence'): unknown;
  readonly tools: { register(tool: HostTool): () => void };
  readonly sessions: { get(id: string): SessionIdentity | undefined };
  readonly workspaceRegistry: {
    resolveByPath(cwd: string): Promise<{ readonly path: string } | undefined>;
  };
  readonly sessionPersistence?: {
    stat(id: string, options?: { signal?: AbortSignal }): Promise<{ readonly header: { readonly cwd?: string } } | undefined>;
  };
  readonly connection?: { readonly fetch: { register(route: FetchRoute): () => Promise<void> } };
  readonly logger?: { warn(message: string): void };
  on?: {
    (name: 'agent/created', listener: (event: { agent: HostAgent; signal?: AbortSignal }) => Promise<void>): Dispose;
    (name: 'agent/disposed', listener: (event: { agent: HostAgent }) => void): Dispose;
  };
  inject(deps: string[], callback: (ctx: HostContext) => void): unknown;
  effect(execute: () => () => void | Promise<void>, label?: string): unknown;
}
