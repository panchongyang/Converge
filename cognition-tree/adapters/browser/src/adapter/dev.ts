/**
 * 浏览器开发坞的存储与预算控制（只在独立网页出现）。
 *
 * 职责：给开发坞一个只读观测面——已提交版本、测试存储真实字节、最近一次 readView
 * 实际返回的节点/引用/序列化字节与所用预算；以及三个控制：模拟延迟、让下一次保存失败、
 * 清空本树测试存储。
 * 边界：树数据只经内核读写；这里不重算扫描次数，也不把本地推测的数字当预算证据。
 * 状态归属：订阅者集合、模拟延迟、最近一次读取观测由本类持有；持久化状态在 TreeStore。
 */
import type { Budget, TreeView } from '@cognition-tree/kernel/types';
import type { TreeId } from '@cognition-tree/kernel/types';
import type { LocalStorageTreeStore } from './storage/localstorage-store';

/** 最近一次 readView 的真实返回量；不包含内核未公布的扫描计数。 */
export interface ReadObservation {
  /** 页面本地时刻，仅供开发坞按时间排序。 */
  at: string;
  /** 读取所基于的已提交版本。 */
  stamp: number;
  /** 实际返回的节点行数（命中与连接合计）。 */
  nodes: number;
  /** 实际返回的引用边数。 */
  refs: number;
  /** 完整响应的 UTF-8 字节数（JSON.stringify 后计）。 */
  bytes: number;
  /** 边界标记数，含 scope / exhausted / budget。 */
  boundaries: number;
  /** 本次是否已覆盖请求范围。 */
  complete: boolean;
  /** 调用方本次给的预算上限。 */
  budget: Budget;
  /** 超限策略。 */
  onLimit: 'fold' | 'exact';
  /** 焦点描述：节点 ID，或“根”。 */
  focus: string;
}

/** 开发坞可用的控制与观测；subscribe/version 供 useSyncExternalStore 订阅。 */
export interface DevControls {
  subscribe(listener: () => void): () => void;
  /** 每次提交或控制项变化加一。 */
  version(): number;
  /** 每次调用前的模拟延迟（毫秒）。 */
  latency(): number;
  setLatency(ms: number): void;
  /** “让下一次保存失败”是否已就绪、尚未被某次提交用掉。 */
  armed(): boolean;
  armFailure(): void;
  /** 当前已提交版本；树不存在时为 null。 */
  stamp(): number | null;
  /** 测试存储里这棵树的 UTF-8 字节数。 */
  storageBytes(): number;
  /** 最近一次 readView 的实际返回量；还没读过为 null。 */
  lastRead(): ReadObservation | null;
  /** 清空这棵树的测试存储（调用方随后应重载页面）。 */
  clear(): void;
}

/**
 * 开发坞控制实现；env 在提交成功或读取成功时调用 noteCommit / observeRead。
 */
export class BrowserDevControls implements DevControls {
  private readonly store: LocalStorageTreeStore;
  private readonly treeId: TreeId;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private delayMs = 0;
  private last: ReadObservation | null = null;

  /**
   * @param store 本页的 localStorage TreeStore
   * @param treeId 页面使用的树
   */
  constructor(store: LocalStorageTreeStore, treeId: TreeId) {
    this.store = store;
    this.treeId = treeId;
    // useSyncExternalStore 会以裸函数调用 subscribe / version，先把 this 固定住。
    this.subscribe = this.subscribe.bind(this);
    this.version = this.version.bind(this);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  version(): number {
    return this.revision;
  }

  latency(): number {
    return this.delayMs;
  }

  setLatency(ms: number): void {
    this.delayMs = Math.max(0, Math.floor(ms));
    this.notify();
  }

  armed(): boolean {
    return this.store.failureArmed();
  }

  armFailure(): void {
    this.store.armNextCommitFailure();
    this.notify();
  }

  stamp(): number | null {
    return this.store.committedStamp(this.treeId);
  }

  storageBytes(): number {
    return this.store.storageBytes(this.treeId);
  }

  lastRead(): ReadObservation | null {
    return this.last;
  }

  clear(): void {
    this.store.clear(this.treeId);
    this.last = null;
    this.notify();
  }

  /** 一次写事务提交成功后调用：让开发坞重读版本与保存失败状态。 */
  noteCommit(): void {
    this.notify();
  }

  /**
   * 记录一次 readView 的真实返回量。
   * @param view 内核返回的树视图
   * @param budget 调用方本次给的预算
   * @param onLimit 超限策略
   * @param focus 焦点描述
   */
  observeRead(
    view: TreeView,
    budget: Budget,
    onLimit: 'fold' | 'exact',
    focus: string,
  ): void {
    this.last = {
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      stamp: view.stamp,
      nodes: view.nodes.length,
      refs: view.refs.length,
      bytes: new TextEncoder().encode(JSON.stringify(view)).length,
      boundaries: view.boundaries.length,
      complete: view.complete,
      budget,
      onLimit,
      focus,
    };
    this.notify();
  }

  private notify(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (e) {
        // 渲染或订阅方的异常不能反过来改变一次已经成功的写入结果。
        console.error('开发坞通知的订阅者出错', e);
      }
    }
  }
}
