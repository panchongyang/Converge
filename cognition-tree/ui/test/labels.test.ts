/**
 * 显示用确认程度的派生：领域只有 confirmation + currentChange，不保留旧原型字段。
 */
import { describe, expect, it } from 'vitest';
import { confirmationLabel, confirmationView, isAiProposed, stateLabel } from '../src/utils/labels';

describe('确认程度三态与未载', () => {
  it('人确认独立于谁执行', () => {
    const view = confirmationView({ confirmation: 'humanConfirmed', currentChange: { revisionId: 'rev-1', by: 'ai' } });
    expect(view).toBe('humanConfirmed');
    expect(confirmationLabel(view)).toBe('人确认');
  });

  it('AI 执行且未确认 → AI 提出', () => {
    const view = confirmationView({ confirmation: 'unconfirmed', currentChange: { revisionId: 'rev-1', by: 'ai' } });
    expect(view).toBe('proposed');
    expect(isAiProposed({ confirmation: 'unconfirmed', currentChange: { revisionId: 'rev-1', by: 'ai' } })).toBe(true);
    expect(confirmationLabel(view)).toBe('AI 提出');
  });

  it('人执行但未确认 → 未确认，不冒充 AI 提出', () => {
    const view = confirmationView({ confirmation: 'unconfirmed', currentChange: { revisionId: 'rev-1', by: 'human' } });
    expect(view).toBe('unconfirmed');
    expect(confirmationLabel(view)).toBe('未确认');
  });

  it('导入待确认（无日常变更）→ 未确认', () => {
    expect(confirmationView({ confirmation: 'unconfirmed' })).toBe('unconfirmed');
  });

  it('确认程度缺失 → 确认未载，不用 null 冒充事实', () => {
    expect(confirmationView({})).toBeNull();
    expect(confirmationLabel(null)).toBe('确认未载');
  });

  it('分支状态缺失 → 状态未载', () => {
    expect(stateLabel(undefined)).toBe('状态未载');
    expect(stateLabel('keep')).toBe('留');
    expect(stateLabel('open')).toBe('未决');
    expect(stateLabel('prune')).toBe('剪');
  });
});
