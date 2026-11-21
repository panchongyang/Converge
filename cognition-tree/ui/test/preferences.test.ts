/**
 * 界面偏好：缺省、往返、坏数据与不可用存储都只回退到缺省，不影响其它设置。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, readPreferences, writePreferences } from '../src/utils/preferences';

/** 最小 Storage 替身。 */
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

describe('界面偏好', () => {
  it('没有记录时用缺省：跟随系统、径向布局', () => {
    expect(readPreferences(memoryStorage())).toEqual(DEFAULT_PREFERENCES);
  });

  it('写入后能原样读回', () => {
    const storage = memoryStorage();
    writePreferences({ theme: 'celadon', layout: 'horizontal' }, storage);
    expect(readPreferences(storage)).toEqual({ theme: 'celadon', layout: 'horizontal' });
  });

  it('坏数据只回退坏的那一项', () => {
    const storage = memoryStorage();
    storage.setItem('cognition-tree:preferences', JSON.stringify({ theme: 'neon', layout: 'vertical' }));
    expect(readPreferences(storage)).toEqual({ theme: 'auto', layout: 'vertical' });
    storage.setItem('cognition-tree:preferences', '{broken');
    expect(readPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  it('存储不可用时静默退化', () => {
    expect(readPreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(() => writePreferences({ theme: 'sand', layout: 'radial' }, null)).not.toThrow();
  });
});
