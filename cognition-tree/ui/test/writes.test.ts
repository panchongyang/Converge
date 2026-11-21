/**
 * 人的动作 → 正式内核输入（纯映射）与确认目标绑定。
 */
import { describe, expect, it } from 'vitest';
import {
  addBranchDraft,
  addBranchPlacement,
  confirmTargetOf,
  pruneDecision,
  replacementDecision,
  reviveDecision,
  switchDecision,
} from '../src/models/writes';
import { missingWriterFields, writeFromWriter } from '../src/modules/inspector/writer';
import { detail, formation, node } from './fixtures';

describe('决定映射', () => {
  it('剪除 / 重新启用 / 切换留未决 / 执行替代分别对应内核决定名', () => {
    expect(pruneDecision('不走', '条件变')).toEqual({ type: 'prune', reason: '不走', reviveWhen: '条件变' });
    expect(reviveDecision('open', '重新考虑')).toEqual({ type: 'revive', state: 'open', reason: '重新考虑' });
    expect(switchDecision('keep', '可以留下')).toEqual({ type: 'setOpenOrKeep', state: 'keep', reason: '可以留下' });
    expect(replacementDecision('剪旧', '旧条件变')).toEqual({
      type: 'applyReplacement',
      reason: '剪旧',
      reviveWhen: '旧条件变',
    });
  });

  it('新判断草稿不设置确认，也不覆盖旧正文', () => {
    expect(addBranchDraft('新判断', '', 'keep')).toEqual({ body: { title: '新判断' }, state: 'keep', refs: [] });
    expect(addBranchDraft('新判断', '说明', 'open')).toEqual({
      body: { title: '新判断', text: '说明' },
      state: 'open',
      refs: [],
    });
    expect(addBranchPlacement('T1.2', 'erratum')).toEqual({ parentId: 'T1.2', kind: 'erratum' });
  });
});

describe('书写区 → 正式写入', () => {
  it('必填项校验只拦缺失的必填字段', () => {
    expect(missingWriterFields('prune', {})).toEqual(['reason', 'reviveWhen']);
    expect(missingWriterFields('prune', { reason: 'r', reviveWhen: 'v' })).toEqual([]);
    expect(missingWriterFields('erratum', {})).toEqual(['title']);
    expect(missingWriterFields('erratum', { title: 't' })).toEqual([]);
  });

  it('剪 / 复活 / 切换 / 执行替代都组装成对应决定', () => {
    expect(writeFromWriter('prune', { reason: '不走', reviveWhen: '条件变' }, 'T1.2')).toEqual({
      kind: 'decision',
      decision: { type: 'prune', reason: '不走', reviveWhen: '条件变' },
    });
    expect(writeFromWriter('revive', { state: 'open', reason: '变了' }, 'T1.2')).toEqual({
      kind: 'decision',
      decision: { type: 'revive', state: 'open', reason: '变了' },
    });
    expect(writeFromWriter('switch', { state: 'keep', reason: '可以留下' }, 'T1.2')).toEqual({
      kind: 'decision',
      decision: { type: 'setOpenOrKeep', state: 'keep', reason: '可以留下' },
    });
    expect(writeFromWriter('accept', { reason: '剪旧', reviveWhen: '旧条件变' }, 'T1.2')).toEqual({
      kind: 'decision',
      decision: { type: 'applyReplacement', reason: '剪旧', reviveWhen: '旧条件变' },
    });
  });

  it('新增子判断 / 补充 / 勘误落点正确，正文去空白后才提交', () => {
    expect(writeFromWriter('erratum', { title: ' 更正后的判断 ', text: ' 哪里不对 ' }, 'T1.2')).toEqual({
      kind: 'addBranch',
      parentId: 'T1.2',
      relation: 'erratum',
      draft: { body: { title: '更正后的判断', text: '哪里不对' }, state: 'keep', refs: [] },
    });
    expect(writeFromWriter('branch', { title: '子判断' }, 'T1.2')).toEqual({
      kind: 'addBranch',
      parentId: 'T1.2',
      relation: 'branch',
      draft: { body: { title: '子判断' }, state: 'keep', refs: [] },
    });
    expect(writeFromWriter('supplement', { title: '补充', state: 'open' }, 'T1.2')).toMatchObject({
      kind: 'addBranch',
      relation: 'supplement',
      draft: { state: 'open' },
    });
  });
});

describe('确认目标绑定', () => {
  it('优先绑定 readNode 带回的那条形成记录 ID，而不是节点指针上的旧值', () => {
    const n = node('T1.1', { confirmation: 'unconfirmed', currentChange: { revisionId: 'rev-old', by: 'ai' } });
    expect(confirmTargetOf(detail(n, formation('rev-new')))).toEqual({ revisionId: 'rev-new' });
  });

  it('没有 currentChange 全文时绑定节点当前指针', () => {
    const n = node('T1.1', { confirmation: 'unconfirmed', currentChange: { revisionId: 'rev-1', by: 'human' } });
    expect(confirmTargetOf(detail(n))).toEqual({ revisionId: 'rev-1' });
  });

  it('导入判断绑定节点本身；确认未载的导入判断允许显式确认', () => {
    expect(confirmTargetOf(detail(node('T1.2', { confirmation: 'unconfirmed' })))).toEqual({ seedNodeId: 'T1.2' });
    expect(confirmTargetOf(detail(node('T1.3')))).toEqual({ seedNodeId: 'T1.3' });
  });

  it('未执行的替代候选可先单独确认；确认不触发替代，执行替代走另一个决定', () => {
    const candidate = node('T1.3', {
      confirmation: 'unconfirmed',
      currentChange: { revisionId: 'rev-1', by: 'ai' },
      origin: { kind: 'replacement', replacesId: 'T1.2', status: 'proposed' },
    });
    expect(confirmTargetOf(detail(candidate, formation('rev-1')))).toEqual({ revisionId: 'rev-1' });
    const executed = {
      ...candidate,
      origin: { kind: 'replacement' as const, replacesId: 'T1.2', status: 'applied' as const },
      currentChange: { revisionId: 'rev-2', by: 'ai' as const },
    };
    expect(confirmTargetOf(detail(executed, formation('rev-2')))).toEqual({ revisionId: 'rev-2' });
    expect(writeFromWriter('accept', { reason: '剪旧', reviveWhen: '旧条件变' }, 'T1.3')).toEqual({
      kind: 'decision',
      decision: { type: 'applyReplacement', reason: '剪旧', reviveWhen: '旧条件变' },
    });
  });

  it('已人确认或未读到节点时没有可确认目标', () => {
    expect(confirmTargetOf(detail(node('T1.1', { confirmation: 'humanConfirmed' })))).toBeNull();
    expect(confirmTargetOf(null)).toBeNull();
  });
});
