/**
 * T1 一次性自举的翻译用例。
 *
 * 对照仓库根《认知树.md》核对 ID、父子、引用、历史行序、日期精度与缺项；另用改坏的
 * 手稿证明无法可靠映射时明确报错，不静默忽略。种子只用于人从 UI 明确触发的一次性导入。
 */
import { describe, expect, it } from 'vitest';
import type { SeedHistoryEntry } from '@cognition-tree/kernel/types';
import manuscript from '../../../../认知树.md?raw';
import { createT1Seed } from '../src/bootstrap';
import { ManuscriptError, translateT1Manuscript } from '../src/bootstrap/manuscript';

/** 手稿里的稳定节点 ID，按概览顺序。 */
const IDS = [
  'T1', 'T1.1', 'T1.2', 'T1.2.1', 'T1.2.2', 'T1.2.3', 'T1.2.4', 'T1.2.5',
  'T1.3', 'T1.3.1', 'T1.3.2', 'T1.3.3', 'T1.3.3.1', 'T1.3.3.2', 'T1.3.3.3',
];

/**
 * 把真实手稿中唯一出现的一段原文替换掉；匹配用例以 LF 写，兼容 Windows worktree 的 CRLF 检出。
 * @param source 手稿全文
 * @param from 必须唯一出现的原文
 * @param to 替换后的内容
 * @returns 改坏的手稿，用于错误路径
 */
function replaceOnce(source: string, from: string, to: string): string {
  const normalized = source.replace(/\r\n/g, '\n');
  const index = normalized.indexOf(from);
  expect(index, `手稿应包含「${from}」`).toBeGreaterThanOrEqual(0);
  return normalized.slice(0, index) + to + normalized.slice(index + from.length);
}

/** 取一个节点，断言存在后返回。 */
function node(seed: ReturnType<typeof createT1Seed>, id: string) {
  const found = seed.nodes.find((candidate) => candidate.id === id);
  expect(found, `节点 ${id} 应存在`).toBeDefined();
  return found!;
}

describe('T1 一次性自举种子', () => {
  it('来自仓库手稿，而不是浏览器样例或手写副本', () => {
    expect(manuscript).toContain('# 认知树（实验性自举）');
    expect(manuscript).toContain('## 形成记录');
    expect(createT1Seed()).toEqual(translateT1Manuscript(manuscript));
  });

  it('15 个判断、7 条引用、10 条形成与确认记录，根是 T1', () => {
    const seed = createT1Seed();
    expect(seed.treeId).toBe('T1');
    expect(seed.rootId).toBe('T1');
    expect(seed.nodes.map((node) => node.id)).toEqual(IDS);
    expect(seed.refs).toHaveLength(7);
    expect(seed.history).toHaveLength(10);
  });

  it('沿用原 ID 与真实父子关系，子节点 ID 与父层级一致', () => {
    const seed = createT1Seed();
    expect(Object.fromEntries(seed.nodes.map((node) => [node.id, node.parentId]))).toEqual({
      T1: null,
      'T1.1': 'T1',
      'T1.2': 'T1',
      'T1.2.1': 'T1.2',
      'T1.2.2': 'T1.2',
      'T1.2.3': 'T1.2',
      'T1.2.4': 'T1.2',
      'T1.2.5': 'T1.2',
      'T1.3': 'T1',
      'T1.3.1': 'T1.3',
      'T1.3.2': 'T1.3',
      'T1.3.3': 'T1.3',
      'T1.3.3.1': 'T1.3.3',
      'T1.3.3.2': 'T1.3.3',
      'T1.3.3.3': 'T1.3.3',
    });
    for (const node of seed.nodes) {
      expect('currentChange' in node, `${node.id} 导入时没有日常变更指针`).toBe(false);
      expect(node.origin).toEqual({ kind: 'branch' });
    }
  });

  it('手稿缺项保持缺失：T1.3 无状态与确认来源，T1.3.1 无复活条件', () => {
    const seed = createT1Seed();
    expect(node(seed, 'T1.3').state).toBeUndefined();
    expect(node(seed, 'T1.3').confirmation).toBeUndefined();
    expect(node(seed, 'T1.3').body.note).toBe('已有结论（见 T1.3.3）');
    expect(node(seed, 'T1.3.1').pruneReason).toBe('共享前提、同类实例、与事实冲突这三种关系无法表达；靠复制节点表达，前提失效时容易漏改。');
    expect(node(seed, 'T1.3.1').reviveWhen).toBeUndefined();
  });

  it('正文、状态、确认来源与剪除信息逐字来自手稿', () => {
    const seed = createT1Seed();
    const t11 = node(seed, 'T1.1');
    expect(t11.state).toBe('prune');
    expect(t11.confirmation).toBe('humanConfirmed');
    expect(t11.body.note).toBe('人类以 T1.2 的表述接受了这一点');
    expect(t11.pruneReason).toBe('保存的是过程，不是认知；树的组织和导航负担落在人身上。查名词这类分支通常已经闭合，没必要作为结构长期保留；而质疑类分支如果不回流主线，会造成虚假对齐（[idea3](idea3.md)）。');
    expect(t11.reviveWhen).toBe('研究目标变成复盘对话过程本身。');

    const t124 = node(seed, 'T1.2.4');
    expect(t124.state).toBe('open');
    expect(t124.confirmation).toBe('unconfirmed');
    expect(t124.body.note).toBeUndefined();
    expect(t124.body.openReason).toBe('尚未讨论概念层的结构，以及它与决策树的关系。');

    const t1333 = node(seed, 'T1.3.3.3');
    expect(t1333.state).toBe('prune');
    expect(t1333.confirmation).toBe('humanConfirmed');
    expect(t1333.body.note).toBe('人决定');

    expect(node(seed, 'T1').state).toBe('open');
    expect(node(seed, 'T1').confirmation).toBeUndefined();
    expect(node(seed, 'T1.2.2').body.title).toBe('剪枝记录理由及成立条件');
    expect(node(seed, 'T1.2.2').body.basis).toBe('剪枝是否成立，取决于当时的条件；只记"剪了"，条件变化后就没人知道该重新考虑。');
  });

  it('引用保留原方向、类型、外部材料定位符与树内剪除理由', () => {
    const seed = createT1Seed();
    expect(seed.refs).toEqual([
      { id: 'ref-T1.2.2-1', from: 'T1.2.2', kind: 'example', target: { doc: 'research/cognition-events-2026-11-15.md', part: 'E02' } },
      { id: 'ref-T1.2.3-1', from: 'T1.2.3', kind: 'example', target: { doc: 'experiments/E02-project-recall/results.md' } },
      { id: 'ref-T1.2.5-1', from: 'T1.2.5', kind: 'premise', target: { nodeId: 'T1.1', part: 'pruneReason' } },
      { id: 'ref-T1.2.5-2', from: 'T1.2.5', kind: 'example', target: { doc: 'idea.md' } },
      { id: 'ref-T1.3.3.1-1', from: 'T1.3.3.1', kind: 'premise', target: { nodeId: 'T1.3.2', part: 'pruneReason' } },
      { id: 'ref-T1.3.3.2-1', from: 'T1.3.3.2', kind: 'premise', target: { nodeId: 'T1.1', part: 'pruneReason' } },
      { id: 'ref-T1.3.3.2-2', from: 'T1.3.3.2', kind: 'example', target: { nodeId: 'T1.2.5' } },
    ]);
    for (const ref of seed.refs) {
      expect(Object.keys(ref).sort()).toEqual(['from', 'id', 'kind', 'target']);
    }
  });

  it('历史按原行序保留 8 行、原出处与日期精度；混合行拆开共用出处', () => {
    const seed = createT1Seed();
    expect(seed.history.map((entry) => entry.source)).toEqual([
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
    expect(seed.history.map((entry) => entry.kind)).toEqual([
      'formation', 'formation', 'confirmation', 'formation', 'formation',
      'formation', 'confirmation', 'formation', 'formation', 'confirmation',
    ]);
    for (const entry of seed.history) {
      expect(entry.at).toBe('2026-11-19');
      expect(entry.by).toBe('import');
      expect(entry.detail).toBeUndefined();
    }
    expect(seed.history[0].summary).toBe('人类引入树形对话产品；AI 分析认为它保存的是过程而不是认知 —— 长出 T1；提出剪除 T1.1');
    expect(seed.history[2].summary).toBe('人类归纳为决策树：长出和剪掉的分支都如实记录 —— T1.1 的剪除得到确认');
  });

  it('第 2、6 行按原意拆分，第 8 行只确认五个节点，不含仍未决的 T1.2.4', () => {
    const seed = createT1Seed();
    const nodeIdsOf = (entry: SeedHistoryEntry) => entry.nodeIds;
    expect(seed.history.map(nodeIdsOf)).toEqual([
      ['T1', 'T1.1'],
      ['T1.2', 'T1.2.1'],
      ['T1.1'],
      ['T1.2.2', 'T1.2.3', 'T1.2.4', 'T1.2.5'],
      ['T1.3'],
      ['T1.3.1', 'T1.3.2', 'T1.3.3', 'T1.3.3.1', 'T1.3.3.2', 'T1.3.3.3'],
      ['T1.3.3'],
      ['T1.3.1', 'T1.3.2', 'T1.3.3.3'],
      ['T1'],
      ['T1.2.2', 'T1.2.3', 'T1.2.5', 'T1.3.3.1', 'T1.3.3.2'],
    ]);
    expect(seed.history[9].summary).toContain('T1.2.4 仍未决');
  });

  it('每次调用返回独立对象，改动一份不污染下一次导入', () => {
    const first = createT1Seed();
    const second = createT1Seed();
    first.nodes[0].body.title = '改过';
    first.history[0].summary = '改过';
    expect(second.nodes[0].body.title).toBe('共同认知用什么结构表达？');
    expect(second.history[0].summary).not.toBe('改过');
  });
});

describe('手稿无法可靠映射时明确报错', () => {
  it('未知状态写法', () => {
    const broken = replaceOnce(
      manuscript,
      '- 状态：剪 · 人确认\n- 剪除理由：共享前提',
      '- 状态：剪 · 已确认\n- 剪除理由：共享前提',
    );
    expect(() => translateT1Manuscript(broken)).toThrow(ManuscriptError);
    expect(() => translateT1Manuscript(broken)).toThrow(/无法识别的状态/);
    expect(() => translateT1Manuscript(broken)).toThrow(/第 \d+ 行/);
  });

  it('节点章节出现未知字段', () => {
    const broken = replaceOnce(
      manuscript,
      '- 状态：留 · 人确认（由人类提出的归纳）',
      '- 状态：留 · 人确认（由人类提出的归纳）\n- 备注：原型里的写法',
    );
    expect(() => translateT1Manuscript(broken)).toThrow(/未知字段「备注」/);
  });

  it('引用分类或目标无法识别', () => {
    const badKind = replaceOnce(manuscript, '同类实例 → [认知事件 E02]', '某种关系 → [认知事件 E02]');
    expect(() => translateT1Manuscript(badKind)).toThrow(/引用无法识别/);
    const badTarget = replaceOnce(manuscript, '同类实例 → T1.2.5', '同类实例 → T1.99');
    expect(() => translateT1Manuscript(badTarget)).toThrow(/不在种子节点里/);
  });

  it('形成记录缺行、日期精度或节点 ID 无法对应', () => {
    const missing = replaceOnce(
      manuscript,
      '| 8 | 2026-11-19 | 人确认了列出的五条 AI 提议，纳入认知树 MVP 的设计依据 | T1.2.2、T1.2.3、T1.2.5、T1.3.3.1、T1.3.3.2 由 AI 提出转为人确认；树的拓扑不变。T1.2.4 仍未决。 |\n',
      '',
    );
    expect(() => translateT1Manuscript(missing)).toThrow(/形成记录应有 8 行/);
    const badDate = replaceOnce(manuscript, '| 1 | 2026-11-19 |', '| 1 | 2026-11 |');
    expect(() => translateT1Manuscript(badDate)).toThrow(/日期「2026-11」/);
    const badNode = replaceOnce(manuscript, '长出 T1；提出剪除 T1.1', '长出 T1；提出剪除 T1.99');
    expect(() => translateT1Manuscript(badNode)).toThrow(/节点 T1\.99 不在树概览里/);
  });

  it('概览里的节点缺少章节，或章节状态与概览不一致', () => {
    const withoutSection = manuscript.replace(/### T1\.3\.3\.3[\s\S]*?(?=\n## |\s*$)/, '');
    expect(withoutSection).not.toBe(manuscript);
    expect(() => translateT1Manuscript(withoutSection)).toThrow(/没有对应章节/);
    const mismatch = replaceOnce(
      manuscript,
      '- 状态：剪 · 人决定\n- 剪除理由：人类判断讨论已经足以理解，不需要实验。',
      '- 状态：留 · 人确认\n- 剪除理由：人类判断讨论已经足以理解，不需要实验。',
    );
    expect(() => translateT1Manuscript(mismatch)).toThrow(/章节状态与树概览不一致/);
  });
});
