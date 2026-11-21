/**
 * 样例种子（T1）的用例：对照手稿核对 ID、父子、引用、历史行序与原精度。
 *
 * 这不是自举实现的测试；它保证适配器交给 bootstrapTree 的 SeedTree 没有在转写中
 * 丢节点、丢引用、补造手稿没有的字段，也不把引用注释混进正式类型。
 */
import { describe, expect, it } from 'vitest';
import { createT1Seed } from './t1-seed';

describe('T1 样例种子', () => {
  it('15 个判断、7 条引用、10 条形成与确认记录，根是 T1', () => {
    const seed = createT1Seed();
    expect(seed.treeId).toBe('T1');
    expect(seed.rootId).toBe('T1');
    expect(seed.nodes).toHaveLength(15);
    expect(seed.refs).toHaveLength(7);
    expect(seed.history).toHaveLength(10);
  });

  it('沿用原 ID 与真实父子关系，根没有父节点', () => {
    const seed = createT1Seed();
    const ids = seed.nodes.map((n) => n.id);
    expect(ids).toEqual([
      'T1', 'T1.1', 'T1.2', 'T1.2.1', 'T1.2.2', 'T1.2.3', 'T1.2.4', 'T1.2.5',
      'T1.3', 'T1.3.1', 'T1.3.2', 'T1.3.3', 'T1.3.3.1', 'T1.3.3.2', 'T1.3.3.3',
    ]);
    const byId = new Map(seed.nodes.map((n) => [n.id, n]));
    expect(byId.get('T1')?.parentId).toBeNull();
    for (const node of seed.nodes) {
      if (node.parentId === null) continue;
      expect(byId.has(node.parentId), node.id + ' 的父亲存在').toBe(true);
    }
  });

  it('手稿缺项保持缺失：T1.3 没有分支状态与确认来源，T1.3.1 没有复活条件', () => {
    const byId = new Map(createT1Seed().nodes.map((n) => [n.id, n]));
    expect(byId.get('T1.3')?.state).toBeUndefined();
    expect(byId.get('T1.3')?.confirmation).toBeUndefined();
    expect(byId.get('T1.3.1')?.pruneReason).not.toBeUndefined();
    expect(byId.get('T1.3.1')?.reviveWhen).toBeUndefined();
  });

  it('确认程度沿用导入值：T1.2.4 未确认，其余人确认或未载', () => {
    const byId = new Map(createT1Seed().nodes.map((n) => [n.id, n]));
    expect(byId.get('T1.2.4')?.confirmation).toBe('unconfirmed');
    expect(byId.get('T1.2.2')?.confirmation).toBe('humanConfirmed');
    expect(byId.get('T1.3.3.3')?.confirmation).toBe('humanConfirmed');
  });

  it('引用保留原方向、类型与目标；doc 与 node 两种目标都在', () => {
    const seed = createT1Seed();
    const byId = new Map(seed.refs.map((r) => [r.id, r]));
    expect(byId.get('ref-T1.2.2-1')).toMatchObject({
      from: 'T1.2.2',
      kind: 'example',
      target: { doc: 'research/cognition-events-2026-11-15.md', part: 'E02' },
    });
    expect(byId.get('ref-T1.2.5-1')).toMatchObject({
      from: 'T1.2.5',
      kind: 'premise',
      target: { nodeId: 'T1.1', part: 'pruneReason' },
    });
    expect(byId.get('ref-T1.3.3.2-2')).toMatchObject({
      from: 'T1.3.3.2',
      kind: 'example',
      target: { nodeId: 'T1.2.5' },
    });
    // 正式 Ref 没有 note / label；手稿括注与显示名留在样例注释里，不塞进运行时类型。
    for (const ref of seed.refs) {
      expect(Object.keys(ref).sort()).toEqual(['from', 'id', 'kind', 'target']);
    }
  });

  it('历史按原行序、保留日期精度与原出处，导入记录不补造明细', () => {
    const seed = createT1Seed();
    expect(seed.history.map((h) => h.source)).toEqual([
      '认知树.md 形成记录 #1',
      '认知树.md 形成记录 #2',
      '认知树.md 形成记录 #2',
      '认知树.md 形成记录 #3',
      '认知树.md 形成记录 #4',
      '认知树.md 形成记录 #5',
      '认知树.md 形成记录 #6',
      '认知树.md 形成记录 #6',
      '认知树.md 形成记录 #7',
      '认知树.md 形成记录 #8',
    ]);
    for (const entry of seed.history) {
      expect(entry.at).toBe('2026-11-19');
      expect(entry.by).toBe('import');
      expect(entry.detail).toBeUndefined();
    }
    // 同一行既有形成又有确认时拆开：第 2 行与第 6 行各两条。
    expect(seed.history.filter((h) => h.source?.endsWith('#2'))).toHaveLength(2);
    expect(seed.history.filter((h) => h.source?.endsWith('#6'))).toHaveLength(2);
    expect(seed.history[9].kind).toBe('confirmation');
    expect(seed.history[9].nodeIds).toEqual(['T1.2.2', 'T1.2.3', 'T1.2.5', 'T1.3.3.1', 'T1.3.3.2']);
  });

  it('每次调用都是独立副本，修改一份不污染另一份', () => {
    const a = createT1Seed();
    const b = createT1Seed();
    a.nodes[0].body.title = '改过';
    expect(b.nodes[0].body.title).toBe('共同认知用什么结构表达？');
  });
});
