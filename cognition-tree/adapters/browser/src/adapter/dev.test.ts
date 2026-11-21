/**
 * 开发坞控制面的用例：版本、真实字节、读取观测与失败注入的联动。
 *
 * 读取观测只记录 readView 实际返回的节点/引用/序列化字节与调用方给的预算，
 * 不产生内核未公布的扫描计数。
 */
import { describe, expect, it } from 'vitest';
import type { CognitionNode, TreeView, ViewNode } from '@cognition-tree/kernel/types';
import { BrowserDevControls } from './dev';
import { LocalStorageTreeStore } from './storage/localstorage-store';
import { MemoryStorage } from './storage/memory-storage.test-util';

/** 造一个视图行。 */
function viewNode(id: string): ViewNode {
  return { id, parentId: null, title: id, state: 'open', origin: { kind: 'branch' }, role: 'hit' };
}

/** 造一个最小可绘制的树视图。 */
function view(): TreeView {
  return {
    rootId: 'T1',
    focusId: 'T1',
    nodes: [viewNode('T1'), viewNode('T1.1')],
    refs: [{ id: 'ref-1', from: 'T1', kind: 'premise', target: { nodeId: 'T1.1' } }],
    boundaries: [{ nodeId: 'T1', axis: 'children', kind: 'scope' }],
    complete: false,
    stamp: 3,
  };
}

/** 造根节点。 */
function root(): CognitionNode {
  return { id: 'T1', parentId: null, body: { title: '根' }, state: 'open', origin: { kind: 'branch' } };
}

describe('BrowserDevControls', () => {
  it('版本与测试存储字节来自真实提交，控制项变化会让订阅者收到通知', async () => {
    const storage = new MemoryStorage();
    const store = new LocalStorageTreeStore({ storage });
    const dev = new BrowserDevControls(store, 'T1');
    let version = -1;
    const off = dev.subscribe(() => {
      version = dev.version();
    });
    expect(dev.stamp()).toBeNull();
    expect(dev.storageBytes()).toBe(0);

    await store.transact('T1', 'createNew', (tx) => tx.writeNode(root()));
    dev.noteCommit();
    expect(dev.stamp()).toBe(1);
    const size = dev.storageBytes();
    expect(size).toBeGreaterThan(0);
    // 开发坞每次 render 都会读字节数：第二次必须是缓存命中，不能重扫全部历史。
    storage.resetStats();
    expect(dev.storageBytes()).toBe(size);
    expect(storage.stats.key).toBe(0);
    expect(storage.stats.getItem).toBe(0);
    const beforePending = version;
    dev.setLatency(400);
    expect(dev.latency()).toBe(400);
    expect(version).toBeGreaterThan(beforePending);
    const beforeOff = dev.version();
    off();
    dev.setLatency(0);
    expect(version).toBe(beforeOff);
    expect(dev.version()).toBe(beforeOff + 1);
  });

  it('读取观测是 return 值的实测：节点数、引用数、UTF-8 字节、边界与预算', () => {
    const store = new LocalStorageTreeStore({ storage: new MemoryStorage() });
    const dev = new BrowserDevControls(store, 'T1');
    const v = view();
    dev.observeRead(v, { maxScans: 80, maxNodes: 8, maxBytes: 4000 }, 'fold', 'T1');
    const obs = dev.lastRead();
    expect(obs?.nodes).toBe(2);
    expect(obs?.refs).toBe(1);
    expect(obs?.bytes).toBe(new TextEncoder().encode(JSON.stringify(v)).length);
    expect(obs?.boundaries).toBe(1);
    expect(obs?.complete).toBe(false);
    expect(obs?.budget.maxScans).toBe(80);
    expect(obs?.onLimit).toBe('fold');
    // 没有伪造扫描数：观测里没有 scans 字段。
    expect(obs && 'scans' in obs).toBe(false);
  });

  it('让下一次保存失败与清空都作用在同一个 TreeStore 上', async () => {
    const store = new LocalStorageTreeStore({ storage: new MemoryStorage() });
    const dev = new BrowserDevControls(store, 'T1');
    await store.transact('T1', 'createNew', (tx) => tx.writeNode(root()));
    dev.armFailure();
    expect(dev.armed()).toBe(true);
    await expect(store.transact('T1', 'existing', (tx) => tx.writeNode({ ...root(), id: 'T1.1', parentId: 'T1' }))).rejects.toMatchObject({
      code: 'storage',
    });
    expect(dev.armed()).toBe(false);
    expect(dev.stamp()).toBe(1);

    dev.clear();
    expect(dev.stamp()).toBeNull();
    expect(dev.storageBytes()).toBe(0);
    expect(dev.lastRead()).toBeNull();
  });
});
