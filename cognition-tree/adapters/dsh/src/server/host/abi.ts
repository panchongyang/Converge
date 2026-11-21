/**
 * 已安装 DSH 0.2.2-rc.1 的最小结构契约；不加载 SDK、profile 或宿主服务。
 * 对照 dsh-tools/lib/types/contracts、dsh-client-connection/lib/types/rpc、
 * dsh-session/lib/types/index 与 dsh-workspace/lib/types/index；隔离 ABI 测试使用真实实现。
 */
export interface SessionIdentity {
  readonly id: string;
  readonly header: { readonly cwd?: string };
}

/** 只取宿主执行器已经绑定的 agent/session，不接受工具参数自报身份。 */
export interface ToolExecution {
  readonly agent?: { readonly id: string; readonly session: SessionIdentity };
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

/** 认证与 owner 检查属于 Connection；插件只注册三个 exact 路由，不占 /api fallback。 */
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
  inject(deps: string[], callback: (ctx: HostContext) => void): unknown;
  effect(execute: () => () => void | Promise<void>, label?: string): unknown;
}
