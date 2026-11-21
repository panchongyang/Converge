/**
 * 上次打开的树：按会话记录、按会话隔离、坏数据与超限都退化为“没记”。
 * 用内存 Storage 替身，不碰真实浏览器 localStorage。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLastTree, readLastTree, writeLastTree } from '../src/client/last-tree';

/** 最小 Storage 替身，行为与浏览器一致（值为字符串）。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('上次打开的树', () => {
  it('写入后能按同一会话读回，不同会话互不影响', () => {
    const storage = memoryStorage();
    writeLastTree('session-a', 'tree-a', storage);
    writeLastTree('session-b', 'tree-b', storage);
    expect(readLastTree('session-a', storage)).toBe('tree-a');
    expect(readLastTree('session-b', storage)).toBe('tree-b');
    expect(readLastTree('session-c', storage)).toBeNull();
  });

  it('不写入不合法的树 ID，也不让坏记录挡住读取', () => {
    const storage = memoryStorage();
    writeLastTree('session-a', '../etc/passwd', storage);
    expect(readLastTree('session-a', storage)).toBeNull();
    storage.setItem('dsh-cognition-tree:last-tree', '{not json');
    expect(readLastTree('session-a', storage)).toBeNull();
    writeLastTree('session-a', 'ok-tree', storage);
    expect(readLastTree('session-a', storage)).toBe('ok-tree');
  });

  it('超过上限时保留最近写入的会话', () => {
    const storage = memoryStorage();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 55; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(now + i);
      writeLastTree('session-' + i, 'tree-' + i, storage);
    }
    vi.restoreAllMocks();
    expect(readLastTree('session-54', storage)).toBe('tree-54');
    expect(readLastTree('session-5', storage)).toBe('tree-5');
    expect(readLastTree('session-4', storage)).toBeNull();
  });

  it('清掉记录后回到“没记”', () => {
    const storage = memoryStorage();
    writeLastTree('session-a', 'tree-a', storage);
    clearLastTree('session-a', storage);
    expect(readLastTree('session-a', storage)).toBeNull();
  });

  it('存储不可用时静默退化，不抛错', () => {
    expect(() => writeLastTree('session-a', 'tree-a', null)).not.toThrow();
    expect(readLastTree('session-a', null)).toBeNull();
    expect(() => clearLastTree('session-a', null)).not.toThrow();
  });
});
