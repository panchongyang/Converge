/**
 * 读会话与游标：续读并页、版本一致、边界归属与覆盖。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateSessions,
  appendPage,
  boundaryKey,
  coveredBoundaryKeys,
  openSession,
  removeCoveredBoundaries,
  withoutCursor,
  type ReadSpec,
} from '../src/models/read-sessions';
import { boundary, view, viewNode } from './fixtures';

const spec = (overrides: Partial<ReadSpec> = {}): ReadSpec => ({
  focus: 'T1',
  expand: { subtreeDepth: 1, jumpHops: 0, direction: 'out', jumpFrom: 'anchor', afterJumpDepth: 0 },
  budget: { maxScans: 10, maxNodes: 10, maxBytes: 1000 },
  onLimit: 'fold',
  ...overrides,
});

describe('读会话续读', () => {
  it('同一查询的下一页并入原会话，版本相同', () => {
    const first = view({
      nodes: [viewNode('T1'), viewNode('T1.1', { parentId: 'T1' })],
      boundaries: [boundary('T1.1', 'children', 'budget')],
      cursor: 'q1',
      complete: false,
    });
    const session = openSession('base', spec(), first);
    expect(session.cursor).toBe('q1');
    expect(session.complete).toBe(false);

    const next = view({
      focusId: 'T1',
      nodes: [viewNode('T1.2', { parentId: 'T1' })],
      boundaries: [boundary('T1.2', 'children', 'exhausted')],
      complete: true,
    });
    const merged = appendPage(session, next, boundaryKey({ nodeId: 'T1.1', axis: 'children' }));
    expect(merged).not.toBeNull();
    expect(merged!.nodes.has('T1.1')).toBe(true);
    expect(merged!.nodes.has('T1.2')).toBe(true);
    expect(merged!.cursor).toBeUndefined();
    expect(merged!.complete).toBe(true);
    expect(merged!.boundaries.has('T1.1:children')).toBe(false);
    expect(merged!.boundaries.get('T1.2:children')?.kind).toBe('exhausted');
  });

  it('跨页同版本时，命中节点不会因后页只为连接而降级', () => {
    const session = openSession(
      'base',
      spec(),
      view({
        nodes: [viewNode('T1'), viewNode('T1.1', { parentId: 'T1', role: 'hit' })],
        cursor: 'q1',
        complete: false,
      }),
    );
    const merged = appendPage(session, view({ nodes: [viewNode('T1.1', { parentId: 'T1', role: 'link' })], stamp: 1 }));
    expect(merged!.nodes.get('T1.1')?.role).toBe('hit');
  });

  it('版本不同的续读页不能拼接', () => {
    const session = openSession('base', spec(), view({ stamp: 3, complete: false, cursor: 'q1' }));
    expect(appendPage(session, view({ stamp: 4, nodes: [viewNode('T9')] }))).toBeNull();
  });

  it('已查尽不会被后面的 scope 降级', () => {
    const session = openSession(
      'base',
      spec(),
      view({ boundaries: [boundary('T1', 'children', 'exhausted')], complete: false, cursor: 'q1' }),
    );
    const merged = appendPage(session, view({ boundaries: [boundary('T1', 'children', 'scope')], stamp: 1 }), 'T1:children');
    expect(merged!.boundaries.get('T1:children')?.kind).toBe('exhausted');
  });

  it('清掉游标后仍保留已读部分与边界，供从折叠点重读', () => {
    const session = openSession('base', spec(), view({ boundaries: [boundary('T1', 'children', 'budget')], cursor: 'q1', complete: false }));
    const cleared = withoutCursor(session);
    expect(cleared.cursor).toBeUndefined();
    expect(cleared.boundaries.get('T1:children')?.kind).toBe('budget');
    expect(cleared.nodes.has('T1')).toBe(true);
  });
});

describe('读会话聚合', () => {
  it('合并可见集合、边界归属与游标；版本取最新，全部读完才 complete', () => {
    const base = openSession('base', spec({ focus: { root: true } }), view({ stamp: 2, complete: true }));
    const extra = openSession(
      'x1',
      spec({ focus: 'T1.1' }),
      view({
        stamp: 3,
        focusId: 'T1.1',
        nodes: [viewNode('T1'), viewNode('T1.1', { parentId: 'T1' })],
        boundaries: [boundary('T1.1', 'children', 'budget')],
        cursor: 'q2',
        complete: false,
      }),
    );
    const agg = aggregateSessions([base, extra]);
    expect(agg.stamp).toBe(3);
    expect(agg.complete).toBe(false);
    expect(agg.visible.has('T1.1')).toBe(true);
    expect(agg.boundaries.map((b) => boundaryKey(b))).toEqual(['T1.1:children']);
    expect(agg.boundaryOwner.get('T1.1:children')).toBe('x1');
    expect(agg.cursors.get('x1')).toBe('q2');
  });

  it('角色命中优先于连接', () => {
    const base = openSession('base', spec(), view({ nodes: [viewNode('T1'), viewNode('T1.1', { role: 'link' })] }));
    const extra = openSession('x1', spec({ focus: 'T1.1' }), view({ nodes: [viewNode('T1.1')] }));
    expect(aggregateSessions([base, extra]).roles.get('T1.1')).toBe('hit');
  });

  it('新展开覆盖的边界从其它会话移除，新会话自己的边界保留', () => {
    const base = openSession('base', spec(), view({ boundaries: [boundary('T1.1', 'children', 'scope')] }));
    const extra = openSession(
      'x1',
      spec({ focus: 'T1.1' }),
      view({ focusId: 'T1.1', nodes: [viewNode('T1.1')], boundaries: [boundary('T1.1', 'children', 'scope')] }),
    );
    const sessions = removeCoveredBoundaries(new Map([['base', base], ['x1', extra]]), 'x1', ['T1.1:children']);
    expect(sessions.get('base')!.boundaries.has('T1.1:children')).toBe(false);
    expect(sessions.get('x1')!.boundaries.has('T1.1:children')).toBe(true);
  });

  it('展开深度 0 与引用 0 跳不覆盖任何边界', () => {
    expect(coveredBoundaryKeys('T1.1', { subtreeDepth: 0, jumpHops: 0, direction: 'out', jumpFrom: 'anchor', afterJumpDepth: 0 })).toEqual([]);
    expect(coveredBoundaryKeys('T1.1', { subtreeDepth: 'leaf', jumpHops: 1, direction: 'both', jumpFrom: 'expanded', afterJumpDepth: 0 })).toEqual([
      'T1.1:children',
      'T1.1:refs',
    ]);
  });
});
