/**
 * 树入口的纯逻辑：动作显示词、空状态文案、草稿校验与失败说明。
 * 不渲染组件，也不启动浏览器。
 */
import { describe, expect, it } from 'vitest';
import { ACTION_LABEL } from '../src/utils/labels';
import {
  TREE_ENTRY_COPY,
  TREE_GENESIS_COPY,
  missingTreeTitle,
  openTreeIssue,
  treeDraftIssue,
  treeErrorText,
} from '../src/modules/tree/model';

describe('树入口文案', () => {
  it('createTree 的显示词是“创建树”，与聊天卡/时间线共用同一动作名', () => {
    expect(TREE_ENTRY_COPY.create).toBe('创建树');
    expect(ACTION_LABEL.createTree).toBe('创建树');
  });

  it('空状态只说明新建或打开，不出现“导入”“手稿”等第二种建树方式', () => {
    const copy = [TREE_GENESIS_COPY.action, TREE_GENESIS_COPY.desc, TREE_GENESIS_COPY.note].join('\n');
    expect(copy).toContain('新建');
    expect(copy).toContain('打开');
    expect(copy).not.toMatch(/导入|手稿|样例/);
  });

  it('多树工作区只报当前 ID 没找到，不宣称整个工作区为空', () => {
    expect(missingTreeTitle('T2')).toBe('没有找到树 T2');
    expect(missingTreeTitle('T2')).not.toContain('工作区');
  });
});

describe('表单判定', () => {
  it('树 ID 与根问题都非空白才可提交', () => {
    expect(treeDraftIssue({ treeId: '', rootQuestion: '为什么' })).toContain('树 ID');
    expect(treeDraftIssue({ treeId: 'T2', rootQuestion: '  ' })).toContain('根问题');
    expect(treeDraftIssue({ treeId: 'T2', rootQuestion: '为什么这样定？' })).toBeNull();
  });

  it('打开已知树只要求输入非空白；字符规则由环境的 open 裁决', () => {
    expect(openTreeIssue('')).toContain('树 ID');
    expect(openTreeIssue('   ')).toContain('树 ID');
    expect(openTreeIssue('T9')).toBeNull();
  });
});

describe('失败说明', () => {
  it('保留端口原文，并补上该错误码对树的影响', () => {
    const text = treeErrorText({ code: 'invalid', message: '树已存在，不能重复创建。' });
    expect(text).toContain('树已存在');
    expect(text).toContain('树没有改动');
  });

  it('未知错误码只显示原文，不编造影响', () => {
    expect(treeErrorText({ code: 'custom', message: '服务暂时不可用。' })).toBe('服务暂时不可用。');
  });
});
