/**
 * “全部树”列表的纯逻辑：标题、计数、部分不可用与空状态文案。
 * 不渲染组件，也不启动浏览器或服务。
 */
import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_COPY,
  directoryEmptyCopy,
  directoryItemTitle,
  directorySummary,
  unavailableOnly,
} from '../src/modules/directory/model';

const items = [
  { treeId: 'T2', rootId: 'T2', rootQuestion: '第二个问题' },
  { treeId: 'T1', rootId: 'T1', rootQuestion: '第一个问题' },
];

describe('目录行', () => {
  it('根问题作为主标题，去掉首尾空白；空白时给出可读占位', () => {
    expect(directoryItemTitle({ treeId: 'T1', rootId: 'T1', rootQuestion: '  为什么会这样？  ' })).toBe(
      '为什么会这样？',
    );
    expect(directoryItemTitle({ treeId: 'T1', rootId: 'T1', rootQuestion: '   ' })).toBe(DIRECTORY_COPY.unnamedQuestion);
    expect(directoryItemTitle({ treeId: 'T1', rootId: 'T1', rootQuestion: '' })).not.toBe('');
  });

  it('只把不在 trees 里的不可用 ID 单列，去重并保留原顺序', () => {
    expect(unavailableOnly(items, ['T3', 'T1', 'T3', '', '  ', 'T4'])).toEqual(['T3', 'T4']);
  });

  it('服务端同时给 trees 与 unavailable 时不重复显示同一棵树', () => {
    expect(unavailableOnly(items, ['T2'])).toEqual([]);
  });
});

describe('计数与状态', () => {
  it('空工作区与只有不可用项分开说明', () => {
    expect(directorySummary(0, 0)).toBe('还没有树');
    expect(directorySummary(0, 2)).toBe('共 0 棵树，2 棵暂时读不到');
    expect(directorySummary(3, 0)).toBe('共 3 棵树');
    expect(directorySummary(3, 1)).toBe('共 3 棵树，1 棵暂时读不到');
  });

  it('只有真的没有树也没有不可用项时才显示空状态', () => {
    expect(directoryEmptyCopy(0, 0)).toMatchObject({ action: DIRECTORY_COPY.emptyAction });
    expect(directoryEmptyCopy(1, 0)).toBeNull();
    expect(directoryEmptyCopy(0, 1)).toBeNull();
  });

  it('空状态文案不出现导入、手稿或样例等第二种建树方式', () => {
    const copy = Object.values(directoryEmptyCopy(0, 0) ?? {}).join('\n');
    expect(copy).toContain('新建');
    expect(copy).not.toMatch(/导入|手稿|样例/);
  });
});

