/**
 * 阅读栏书写区的配置与意图组装（纯数据 + 纯映射）。
 *
 * 为什么单独成模块：书写区有多类动作（剪、复活、留/未决切换、执行替代、新增子判断/补充/勘误），
 * 配置与“动作 → 正式输入”的映射都是纯逻辑；拆出来让 Inspector 只负责版面，也便于 Vitest 验证。
 * 边界：不提交、不改缓存；必填校验只决定是否发起提交，最终规则仍由内核守。
 */
import type { NodeId } from '../../types/kernel';
import {
  addBranchDraft,
  pruneDecision,
  replacementDecision,
  reviveDecision,
  switchDecision,
  type BranchRelation,
  type HumanWrite,
} from '../../models/writes';

/** 需要书写区的写入类型；确认不在此列。 */
export type WriterType = 'prune' | 'revive' | 'switch' | 'accept' | BranchRelation;

/** 新增子判断 / 补充 / 勘误的书写区类型。 */
export type BranchWriterType = BranchRelation;

/** 书写区字段：key 对应 WriterState.values。 */
export interface WriterQuestion {
  key: string;
  question: string;
  required: boolean;
}

/** 一类写入的字段与键位提示。 */
export interface WriterConfig {
  questions: WriterQuestion[];
  hint: string;
}

export const WRITER_CONFIG: Record<WriterType, WriterConfig> = {
  prune: {
    questions: [
      { key: 'reason', question: '为什么不走这条路？', required: true },
      { key: 'reviveWhen', question: '什么变化会让它值得重新考虑？', required: true },
    ],
    hint: '两项写完才会剪去',
  },
  revive: {
    questions: [{ key: 'reason', question: '条件发生了什么变化？', required: true }],
    hint: '理由写完才会重新启用',
  },
  switch: {
    questions: [{ key: 'reason', question: '为什么现在可以留下 / 需要重新考虑？', required: true }],
    hint: '理由写完才会改状态',
  },
  accept: {
    questions: [
      { key: 'reason', question: '为什么剪去旧判断？', required: true },
      { key: 'reviveWhen', question: '什么变化会让旧判断值得重新考虑？', required: true },
    ],
    hint: '两项写完才会执行替代',
  },
  branch: {
    questions: [
      { key: 'title', question: '新的子判断', required: true },
      { key: 'text', question: '想补充说明（可选）', required: false },
    ],
    hint: '判断写完才会记下',
  },
  supplement: {
    questions: [
      { key: 'title', question: '补充的判断', required: true },
      { key: 'text', question: '补充说明（可选）', required: false },
    ],
    hint: '判断写完才会记下',
  },
  erratum: {
    questions: [
      { key: 'title', question: '更正后的判断', required: true },
      { key: 'text', question: '哪里不对（可选）', required: false },
    ],
    hint: '判断写完才会记下',
  },
};

/** 新增分支的入口与目标文案。 */
export const BRANCH_WRITER_LABEL: Record<BranchWriterType, string> = {
  branch: '新增子判断',
  supplement: '补充',
  erratum: '勘误',
};

/** 是否是要在节点下新增判断的书写区。 */
export function isBranchWriter(type: WriterType): type is BranchWriterType {
  return type === 'branch' || type === 'supplement' || type === 'erratum';
}

/**
 * 书写区当前选择的分支状态；未选时按留存。
 * @param values 书写内容
 */
export function writerState(values: Record<string, string>): 'keep' | 'open' {
  return values.state === 'open' ? 'open' : 'keep';
}

/**
 * 校验必填项，返回缺少的字段键；空数组表示可以提交。
 * @param type 写入类型
 * @param values 书写内容
 */
export function missingWriterFields(type: WriterType, values: Record<string, string>): string[] {
  return WRITER_CONFIG[type].questions
    .filter((q) => q.required && (values[q.key] ?? '').trim() === '')
    .map((q) => q.key);
}

/**
 * 把书写区的内容组装成一次正式写入。
 * @param type 写入类型
 * @param values 书写内容
 * @param nodeId 被操作的节点（新增分支时是父节点）
 */
export function writeFromWriter(type: WriterType, values: Record<string, string>, nodeId: NodeId): HumanWrite {
  const text = (key: string) => (values[key] ?? '').trim();
  if (type === 'prune') {
    return { kind: 'decision', decision: pruneDecision(text('reason'), text('reviveWhen')) };
  }
  if (type === 'revive') {
    return { kind: 'decision', decision: reviveDecision(writerState(values), text('reason')) };
  }
  if (type === 'switch') {
    return { kind: 'decision', decision: switchDecision(writerState(values), text('reason')) };
  }
  if (type === 'accept') {
    return { kind: 'decision', decision: replacementDecision(text('reason'), text('reviveWhen')) };
  }
  return {
    kind: 'addBranch',
    parentId: nodeId,
    relation: type,
    draft: addBranchDraft(text('title'), text('text'), writerState(values)),
  };
}
