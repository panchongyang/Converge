/**
 * 客户端进程内共享的两个小状态：当前宿主会话与一次明确的跳转意图。
 *
 * 职责：让 root 作用域的主面板/侧栏与 session 作用域的聊天卡对齐“当前会话”，
 * 并把卡片点击的“看哪棵树、哪个节点”交给面板。两块状态都只在浏览器内存里，
 * 不写 localStorage，也不从 URL 猜工作区。
 *
 * 边界：
 * - 当前会话只由宿主 session 作用域给出的 sessionId 写入；面板据此发请求。
 *   没有会话时不发写请求，也不拿别的会话顶替。
 * - 同屏可能挂着多个会话（例如多列对话）。每个会话头分别登记自己的来源；
 *   只有所有来源一致才算“当前会话”。出现分歧时状态是 ambiguous，主面板一律禁用，
 *   不采用“最后注册者胜”。
 * - 跳转意图带自己的 sessionId/treeId；面板只接受与当前会话一致的意图，
 *   或在该会话就是点击来源时把它当作明确选择。跳转只影响选中，不触发任何提交。
 */

/** 只保留非空白字符串；宿主 sessionId 是定位符，不是路径。 */
export function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** 当前会话的三种状态：唯一、没有、多个会话同时登记。 */
export type SessionState =
  | { status: 'ready'; sessionId: string }
  | { status: 'none' }
  | { status: 'ambiguous'; count: number };

/** 状态是否相同；只比较语义，不比较内部 Map。 */
function sameState(a: SessionState, b: SessionState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'ready' && b.status === 'ready') return a.sessionId === b.sessionId;
  if (a.status === 'ambiguous' && b.status === 'ambiguous') return a.count === b.count;
  return true;
}

/** 按来源登记当前会话，汇总为唯一/歧义/没有。 */
export class SessionChannel {
  private readonly sources = new Map<string, string>();
  /** 最近一次见到的会话，最新在前；侧栏打开时用它冻结本次会话，不猜路径。 */
  private readonly recent: string[] = [];
  private state: SessionState = { status: 'none' };
  private readonly listeners = new Set<(state: SessionState) => void>();

  /** 由全部来源重算状态；没有变化不通知。 */
  private recompute(): void {
    const ids = new Set(this.sources.values());
    const next: SessionState =
      ids.size === 0 ? { status: 'none' } : ids.size === 1 ? { status: 'ready', sessionId: [...ids][0]! } : { status: 'ambiguous', count: ids.size };
    if (sameState(next, this.state)) return;
    this.state = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        // 某个订阅者渲染失败不能阻断其他入口拿到当前会话。
        console.error('当前会话订阅者失败', error);
      }
    }
  }

  /**
   * 登记/更新一个来源的会话；空白值等价于撤销该来源。
   * @param source 来源键（每个会话头一个，卸载时撤销）
   * @param sessionId 宿主 session 作用域给出的会话 ID
   */
  attach(source: string, sessionId: unknown): void {
    const id = normalizeId(sessionId);
    if (id) {
      this.sources.set(source, id);
      const at = this.recent.indexOf(id);
      if (at !== -1) this.recent.splice(at, 1);
      this.recent.unshift(id);
      if (this.recent.length > 8) this.recent.length = 8;
    } else this.sources.delete(source);
    this.recompute();
  }

  /**
   * 撤销一个来源。
   * @param source 来源键
   */
  detach(source: string): void {
    if (this.sources.delete(source)) this.recompute();
  }

  /**
   * @returns 已知的宿主会话，最新在前；只用于让用户显式重选，不推断工作区
   */
  recentSessions(): readonly string[] {
    return this.recent;
  }

  /** @returns 当前汇总状态；ambiguous 时调用方必须让用户明确选择，不能挑一个 */
  get(): SessionState {
    return this.state;
  }

  /**
   * 订阅状态变化。
   * @param listener 语义状态变化时调用；订阅本身不立即回调
   * @returns 取消订阅的函数
   */
  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** 一次明确的“打开面板并看这里”意图。 */
export interface JumpIntent {
  /** 发出意图的宿主会话；面板只在它与当前会话一致时消费。 */
  sessionId: string;
  /** 树 ID；来自卡片自身携带的 tool 参数，不来自面板当前树。 */
  treeId: string;
  /** 要选中的节点；缺省只打开面板，不改变选中。 */
  nodeId?: string;
  /** 意图序号，用于面板已挂载时也响应新的点击。 */
  seq: number;
}

/** 保存最近一次跳转意图的进程内信箱。 */
export class JumpChannel {
  private latest: JumpIntent | null = null;
  private seq = 0;
  private readonly listeners = new Set<(intent: JumpIntent) => void>();

  /**
   * 记下一次跳转并通知已挂载的面板。
   * @param sessionId 发出意图的会话
   * @param treeId 卡片携带的树
   * @param nodeId 要选中的节点，可缺省
   * @returns 写入的意图（含序号），供调用方判断/测试
   */
  request(sessionId: string, treeId: string, nodeId?: string): JumpIntent {
    const intent: JumpIntent = {
      sessionId,
      treeId,
      seq: ++this.seq,
      ...(nodeId ? { nodeId } : {}),
    };
    this.latest = intent;
    for (const listener of [...this.listeners]) {
      try {
        listener(intent);
      } catch (error) {
        console.error('跳转订阅者失败', error);
      }
    }
    return intent;
  }

  /** @returns 最近一次跳转，不区分会话；面板挂载时用它接住点击。 */
  current(): JumpIntent | null {
    return this.latest;
  }

  /**
   * 读出仍属当前会话与树的意图；不消费，允许面板重挂后再次对齐。
   * @param sessionId 面板当前会话
   * @param treeId 面板当前树
   * @returns 匹配的意图或 null
   */
  peek(sessionId: string, treeId: string): JumpIntent | null {
    const intent = this.latest;
    if (intent && intent.sessionId === sessionId && intent.treeId === treeId) return intent;
    return null;
  }

  /**
   * 消费一次跳转；只有序号与当前最新一致时才清除，避免旧面板清掉新意图。
   * @param intent 面板已消费的意图
   */
  consume(intent: JumpIntent): void {
    if (this.latest?.seq === intent.seq) this.latest = null;
  }

  /**
   * 订阅新跳转。
   * @param listener 每次 request 后调用
   * @returns 取消订阅的函数
   */
  subscribe(listener: (intent: JumpIntent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** 面板本次打开要绑定的会话；有树 ID 时进入该树，没有时先看“全部树”列表。 */
export interface BoundView {
  sessionId: string;
  /** 明确的树跳转才带；侧栏默认打开不带，由目录让人选。 */
  treeId?: string;
}

/**
 * 计算面板本次打开应绑定的视图（纯逻辑）。
 * 只有两种可信来源会默认绑定：卡片明确跳转，或宿主唯一实时会话（当次冻结）。
 * 卡片跳转直接进树；只有会话时进该工作区的“全部树”列表，不默认任何 T1。
 * 没有实时会话时返回 null；历史会话只能由人从列表里显式选择，不能自动兜底，
 * 否则可能把面板带进另一个工作区。
 * @param native 宿主会话汇总状态
 * @param pending 尚未消费的卡片跳转
 * @returns 绑定视图；没有可信来源或会话歧义时为 null
 */
export function initialBinding(native: SessionState, pending: JumpIntent | null): BoundView | null {
  if (pending) return { sessionId: pending.sessionId, treeId: pending.treeId };
  if (native.status === 'ready') return { sessionId: native.sessionId };
  return null;
}

/** 插件内单例；同一个客户端 bundle 实例共享。 */
export const sessionChannel = new SessionChannel();

/** 跳转单例；卡片与面板共用。 */
export const jumpChannel = new JumpChannel();
