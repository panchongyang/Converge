/**
 * 浏览器入口的提交通知：把适配层写成功的事实分发给订阅者。
 *
 * 为什么在适配层而不是内核：正式内核不发布 UI 事件；DSH 与浏览器各自按宿主通道通知。
 * 本模块只转发“这次提交成功、新增了哪些修订”，不解释修订内容，也不重放读结果。
 * 订阅按树隔离；通知发生在 dispatch 成功返回之前，订阅方收到后应重新读取，不本地猜状态。
 */
import type { TreeChange } from '@cognition-tree/ui/types/ports';
import type { TreeId } from '@cognition-tree/kernel/types';

/** 一次提交的通知形状，与 UI 端口 TreeChange 一致。 */
export type CommitNotice = TreeChange;

/** 按树的提交通知中心；一个页面实例一个。 */
export class ChangeHub {
  private readonly listeners = new Map<TreeId, Set<(change: CommitNotice) => void>>();

  /**
   * 订阅某棵树提交后的变化。
   * @param treeId 要观察的树
   * @param listener 每次提交成功后调用一次，参数是本次新增的修订
   * @returns 取消订阅的函数；组件卸载时必须调用
   */
  subscribe(treeId: TreeId, listener: (change: CommitNotice) => void): () => void {
    let set = this.listeners.get(treeId);
    if (!set) {
      set = new Set();
      this.listeners.set(treeId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(treeId);
    };
  }

  /**
   * 发布一次成功提交；监听者的异常不影响提交结果。
   * @param change 提交后的版本与新增修订
   */
  publish(change: CommitNotice): void {
    const set = this.listeners.get(change.treeId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(change);
      } catch (e) {
        // 订阅方（UI 读回）出错不应把已提交的写操作报成失败。
        console.error('提交后的读回通知失败', e);
      }
    }
  }
}
