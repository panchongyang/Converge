/**
 * DSH 主线程只转发意图、工作区目录读取与变更通知。加载插件、注册工具、打开无关会话都不打开 SQLite 或启动线程。
 * 一个插件实例最多持有一个工作线程；SQLite 异常和线程退出只使本插件的请求失败，不重试未明的写入。
 */
import { Worker } from 'node:worker_threads';
import type { OpInput, OpName, OpOutput } from '@cognition-tree/kernel/catalog/contracts';
import { CognitionError, type DailyActor } from '@cognition-tree/kernel/types';
import type { CommitNotice, Reply, Request } from './protocol';
import type { WorkspaceTreeDirectory } from '../../types/wire';

export interface Backend {
  /**
   * 在该工作区的内核实例上分派，写成功后才兑现；线程断开时请重读，不自动重试。
   * @param root 宿主根据会话解析出的工作区绝对路径
   * @param actor 由工具或人侧入口固定，不从 input 中采信
   * @param op 操作目录中的意图名
   * @param input 与该意图对应的具名参数
   */
  call<K extends OpName>(root: string, actor: DailyActor, op: K, input: OpInput[K]): Promise<OpOutput[K]>;
  /** 只读当前工作区已提交树的根问题目录，不分派领域意图或发布提交通知。@param root 宿主解析的工作区绝对路径。 */
  listTrees(root: string): Promise<WorkspaceTreeDirectory>;
  /** 订阅已提交的通知；listener 失败不会改变写入结果。返回取消订阅函数。 */
  watch(listener: (root: string, change: CommitNotice) => void): () => void;
  /** 停止接收请求、等待已接收请求结束并释放线程；可重复调用。 */
  close(): Promise<void>;
}
type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type RequestInput = Omit<Extract<Request, { kind: 'call' }>, 'id'> | Omit<Extract<Request, { kind: 'listTrees' }>, 'id'>;

/** 装配一个惰性线程客户端。@param workerURL 同一构建产物中的线程入口；测试可指向隔离夹具。 */
export function createBackend(workerURL = new URL('./worker.js', import.meta.url)): Backend {
  const waiting = new Map<number, Waiter>();
  const listeners = new Set<(root: string, change: CommitNotice) => void>();
  let next = 0, worker: Worker | undefined, closed = false;
  let closing: Promise<void> | undefined;

  /** 第一次实际操作才启动；不把宿主的 CLI 参数、测试 loader 或检查器传给 worker。 */
  function connect(): Worker {
    if (worker) return worker;
    const active = new Worker(workerURL, { execArgv: [] });
    worker = active;
    active.on('message', (reply: Reply) => {
      if (worker !== active) return;
      if (reply.kind === 'commit') {
        for (const listener of listeners) {
          try { listener(reply.root, reply.change); } catch { /* 观察者不能改变已提交的事务。 */ }
        }
        return;
      }
      const request = waiting.get(reply.id);
      if (!request) return;
      waiting.delete(reply.id);
      if (reply.kind === 'ok') request.resolve(reply.value);
      else request.reject(new CognitionError(reply.code, reply.message));
    });
    /** 退出和 error 可能相继发生；只处理当前一代，绝不把旧回调作用到新线程。 */
    const disconnected = () => {
      if (worker !== active) return;
      worker = undefined;
      for (const request of waiting.values()) request.reject(new CognitionError('storage', '认知树工作线程已停止；请重新读取以核对提交结果。'));
      waiting.clear();
    };
    active.on('error', disconnected);
    active.once('exit', disconnected);
    return active;
  }
  /** 所有读取与意图共用请求编号、并发上限和关闭排空，不另建目录队列。@param message 已绑定工作区的私有消息。 */
  async function request<T>(message: RequestInput): Promise<T> {
    if (closed) throw new CognitionError('storage', '认知树插件已关闭。');
    // 不把高负载排成无上限的宿主回调或待拷贝消息；只拒绝本插件的新请求。
    if (waiting.size >= 64) throw new CognitionError('storage', '认知树请求过多，请稍后再试。');
    const id = ++next;
    return new Promise<T>((resolve, reject) => {
      try {
        const active = connect();
        waiting.set(id, { resolve: value => resolve(value as T), reject });
        active.postMessage({ ...message, id } satisfies Request);
      } catch {
        waiting.delete(id);
        reject(new CognitionError('storage', '无法向认知树工作线程发送请求。'));
      }
    });
  }
  return {
    call<K extends OpName>(root: string, actor: DailyActor, op: K, input: OpInput[K]) {
      return request<OpOutput[K]>({ kind: 'call', root, actor, op, input });
    },
    listTrees(root) {
      return request<WorkspaceTreeDirectory>({ kind: 'listTrees', root });
    },
    watch(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (closing) return closing;
      closed = true;
      listeners.clear();
      const active = worker;
      if (!active) return Promise.resolve();
      closing = new Promise<void>(resolve => {
        active.once('exit', () => resolve());
        active.postMessage({ kind: 'close' } satisfies Request);
      });
      return closing;
    },
  };
}
