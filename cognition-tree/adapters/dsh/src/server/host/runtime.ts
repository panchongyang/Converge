/**
 * 宿主适配器的生命周期状态：惰性后台、进行中的调用与按工作区分组的已提交通知。
 * 不持有领域数据，不更改宿主的 cwd、鉴权或其它服务；停用只排空自身调用并释放自己的后台。
 */
import { isAbsolute } from 'node:path';
import type { OpInput, OpOutput } from '@cognition-tree/kernel/catalog/contracts';
import { CognitionError, type DailyActor } from '@cognition-tree/kernel/types';
import type { Backend } from '../backend/index';
import type { ProcessInput } from '../backend/protocol';
import type { ProcessRecord } from '../storage/process';
import type { HostContext, SessionIdentity, ToolExecution } from './abi';
import { AI_TOOLS, type ChangeNotice, type UiOp, type WorkspaceTreeDirectory } from '../../types/wire';
import { isOp, parseInput } from './input';

export type BackendFactory = () => Backend | Promise<Backend>;
type Subscriber = { root: string; change(notice: ChangeNotice): void; close(): void };

/** 将未知宿主/后台故障收敛为插件错误，避免把堆栈或本地路径带进 UI。@param error 边界异常。 */
export function boundaryError(error: unknown): CognitionError {
  return error instanceof CognitionError ? error : new CognitionError('storage', '认知树服务暂不可用；请重新读取核对状态。');
}

/**
 * 从宿主会话元数据查注册工作区；HTTP 的 sessionId 是定位符，不是身份授权或路径。
 * @param ctx 受信宿主服务。
 * @param id 已认证人侧所选会话，或执行器绑定的 agent 会话。
 * @param signal 请求生命周期。
 * @param expected AI 入口额外要求仍为 SessionStore 中的同一 live Session。
 */
export async function workspaceOf(ctx: HostContext, id: string, signal: AbortSignal, expected?: SessionIdentity): Promise<string> {
  signal.throwIfAborted();
  const live = ctx.sessions.get(id);
  if (expected && live !== expected) throw new CognitionError('invalid', '工具必须绑定正在运行的宿主会话。');
  // Cordis 对未 inject 的可选服务属性访问会抛错；缺失持久化能力时仍应报告会话不存在。
  const persistence = live || expected ? undefined : ctx.get('sessionPersistence') as HostContext['sessionPersistence'];
  const header = live?.header ?? (expected ? undefined : (await persistence?.stat(id, { signal }))?.header);
  signal.throwIfAborted();
  if (!header) throw new CognitionError('missing', '宿主会话不存在。');
  const cwd = header.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new CognitionError('invalid', '该会话没有可信工作区；不会使用进程目录或请求路径代替。');
  const workspace = await ctx.workspaceRegistry.resolveByPath(cwd);
  signal.throwIfAborted();
  if (expected && ctx.sessions.get(id) !== expected) throw new CognitionError('invalid', '工具所属会话已结束。');
  if (!workspace || !isAbsolute(workspace.path)) throw new CognitionError('invalid', '该会话尚未绑定已注册的 DSH 工作区。');
  return workspace.path;
}

/**
 * 每次插件激活一份；factory 只在第一次认知树调用/订阅时执行，失败可重试但不重试业务写入。
 * @param ctx 宿主服务。
 * @param factory 惰性创建本插件后台，不接管宿主生命周期。
 */
export class HostRuntime {
  private loading?: Promise<Backend>;
  private offBackend?: () => void;
  private readonly calls = new Set<Promise<unknown>>();
  private readonly subscribers = new Set<Subscriber>();
  private stopped = false;
  private closing?: Promise<void>;

  constructor(private readonly ctx: HostContext, private readonly factory: BackendFactory) {}

  /** 拒绝停用后的新工作；已接收的后台提交仍会排空。 */
  assertActive(): void {
    if (this.stopped) throw new CognitionError('storage', '认知树插件已停用。');
  }

  /** 第一次实际使用才创建后台并接一条提交观察者；不因其它会话打开而运行。 */
  private load(): Promise<Backend> {
    if (!this.loading) {
      const loading = Promise.resolve().then(this.factory).then(async backend => {
        try {
          this.offBackend = backend.watch((root, change) => {
            for (const subscriber of [...this.subscribers]) {
              if (subscriber.root !== root) continue;
              try { subscriber.change(change); } catch { subscriber.close(); }
            }
          });
          return backend;
        } catch (error) {
          await backend.close().catch(() => {});
          throw error;
        }
      });
      this.loading = loading;
      void loading.catch(() => { if (this.loading === loading) this.loading = undefined; });
    }
    return this.loading;
  }

  /**
   * 记录从可信入口到后台完成的整次调用，停用时只等待自己接收的工作。
   * @param actor 已在入口固定的角色，绝不来自 input。
   * @param op DSH 显式白名单中的意图；AI 不能确认，人和 AI 都不能自举。
   * @param input 具名领域参数。
   * @param root 已经宿主 registry 解析的工作区。
   * @param signal 接收前的取消；已提交的 worker 调用不因断线而谎称回滚。
   */
  call<K extends UiOp>(actor: DailyActor, op: K, input: OpInput[K], root: string, signal: AbortSignal): Promise<OpOutput[K]> {
    this.assertActive();
    signal.throwIfAborted();
    // 冷加载前再次守住宿主能力边界；内核保留自举并不向 DSH 授予该入口。
    if (!isOp(op) || (actor === 'ai' && !Object.hasOwn(AI_TOOLS, op))) {
      throw new CognitionError('invalid', '该认知树操作未向此宿主入口开放。');
    }
    const checked = parseInput(op, input);
    return this.run(signal, backend => backend.call(root, actor, op, checked));
  }

  /** 只读已定位工作区的导航目录；不使用 catalog 或 AI 工具。@param root 可信 registry 返回的工作区。@param signal 请求及路由挂载的生命周期。 */
  listTrees(root: string, signal: AbortSignal): Promise<WorkspaceTreeDirectory> {
    return this.run(signal, backend => backend.listTrees(root));
  }

  /** 过程材料独立于树目录和读写协议，仍共用插件停用与排空。 */
  process(root: string, input: ProcessInput, signal: AbortSignal): Promise<ProcessRecord> {
    return this.run(signal, backend => backend.process(root, input));
  }

  /** 共用进行中集合与停用排空；冷加载完成前取消的请求不送入后台。@param signal 接收前取消信号。@param work 已在入口限定的后台调用。 */
  private run<T>(signal: AbortSignal, work: (backend: Backend) => Promise<T>): Promise<T> {
    this.assertActive();
    signal.throwIfAborted();
    const pending = this.load().then(backend => {
      signal.throwIfAborted();
      return work(backend);
    }).catch(error => { throw boundaryError(error); });
    this.calls.add(pending);
    void pending.then(() => this.calls.delete(pending), () => this.calls.delete(pending));
    return pending;
  }

  /** AI 工具只能使用执行器绑定且仍存活的会话。@param exec 宿主执行上下文。 */
  async aiWorkspace(exec: ToolExecution): Promise<string> {
    this.assertActive();
    const agent = exec.agent;
    if (!agent || agent.id !== agent.session?.id) throw new CognitionError('invalid', '认知树工具需要宿主绑定的 agent 会话。');
    return workspaceOf(this.ctx, agent.session.id, exec.signal, agent.session);
  }

  /**
   * 只订阅同一规范工作区的提交；不启动 worker、不回放历史。
   * @param subscriber 流持有的工作区、发送与关闭回调。
   * @returns 只移除此订阅的解绑函数。
   */
  async subscribe(subscriber: Subscriber): Promise<() => void> {
    this.assertActive();
    if (this.subscribers.size >= 128) throw new CognitionError('storage', '认知树订阅过多，请关闭闲置面板。');
    await this.load();
    this.assertActive();
    // 冷启动的并发订阅可能同时通过 await 前的检查；接纳时再核一次上限。
    if (this.subscribers.size >= 128) throw new CognitionError('storage', '认知树订阅过多，请关闭闲置面板。');
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  /** 停止通知、等待已接收调用，然后关闭本插件后台；重复调用返回同一排空承诺。 */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const subscriber of [...this.subscribers]) {
      try { subscriber.close(); } catch { /* 一个损坏的流不能阻止其它订阅释放。 */ }
    }
    this.subscribers.clear();
    this.closing = (async () => {
      await Promise.allSettled([...this.calls]);
      const backend = await this.loading?.catch(() => undefined);
      // 冷加载可能在 stop 之后才完成；必须等它装好观察者再解绑，不能漏掉迟到的监听。
      try { this.offBackend?.(); } catch { /* 后台清理仍须继续。 */ }
      this.offBackend = undefined;
      if (backend) await backend.close();
    })();
    return this.closing;
  }
}
