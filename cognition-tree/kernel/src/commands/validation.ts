/** 写侧共用校验（内核接口单 §3.1、§3.4）。只解释领域数据，不从参数中推断身份。 */
import { CognitionError } from '../types';
import type {
  BranchState, CognitionNode, ConfirmTarget, NodeBody, NodeId, RefKind, RefTarget, WriteTransaction,
} from '../types';
import { isNonBlank } from '../utils';

/**
 * 中止不合规或不适用的写入；已开启的事务由存储回滚。
 * @param message 面向调用方的失败原因
 * @throws CognitionError 参数不合规或动作不适用（invalid）
 */
export function invalid(message: string): never {
  throw new CognitionError('invalid', message);
}

/**
 * 检查输入为普通记录而非数组或其他对象；不从原型读取业务字段。
 * @param value 从写入口送来的候选值
 * @param label 用于指出不合规的参数
 * @returns 输入的自有字段，可继续按具体意图校验
 */
export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label}必须是对象`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid(`${label}必须是普通对象`);
  const fields: Record<string, unknown> = Object.create(null);
  return Object.assign(fields, value);
}

/**
 * 拒绝未声明的写入字段，不接受夹带的确认、身份或已有节点数据。
 * @param data 已取出的输入字段
 * @param allowed 当前意图允许填写的键
 * @param label 用于指出不合规的参数
 */
export function onlyFields(data: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) invalid(`${label}不接受字段 ${key}`);
  }
}

/**
 * 校验调用方明确提供了列表；不为缺失的列表设置空数组缺省。
 * @param value 待检查的列表
 * @param label 用于指出不合规的参数
 * @returns 尚需逐项校验的列表
 */
export function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label}必须是数组`);
  return value;
}

/**
 * 校验必填的非空白文本或稳定 ID，保存时不擅自去掉原有空白。
 * @param value 待校验的值
 * @param label 用于指出不合规的参数
 * @returns 未改写的文本
 */
export function requiredText(value: unknown, label: string): string {
  if (!isNonBlank(value)) invalid(`${label}不能为空白`);
  return value;
}

/**
 * 校验可选文本；未提供与明确提供文本是不同的事实。
 * @param value 待校验的值
 * @param label 用于指出不合规的参数
 * @returns 提供的原文字串或缺失
 */
export function optionalText(value: unknown, label: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') invalid(`${label}必须是文本`);
  return value;
}

/**
 * 校验明确给出的分支状态；状态未载只在自举节点上保留。
 * @param value 待校验的状态
 * @returns 留、剪或未决
 */
export function branchState(value: unknown): BranchState {
  if (value !== 'keep' && value !== 'prune' && value !== 'open') {
    invalid('分支状态必须是 keep、prune 或 open');
  }
  return value;
}

/**
 * 校验重新启用或留/未决转换的目标状态。
 * @param value 调用方明确选择的目标状态
 * @returns 留或未决
 */
export function openOrKeep(value: unknown): 'keep' | 'open' {
  if (value !== 'open' && value !== 'keep') invalid('目标状态必须是 keep 或 open');
  return value;
}

/**
 * 校验并独立复制新正文，只保存契约中的文字字段，缺项不补空串。
 * @param value 草稿或手稿提供的正文
 * @returns 可以作为新节点不可覆盖正文的副本
 */
export function nodeBody(value: unknown): NodeBody {
  const data = record(value, '正文');
  const optional = ['text', 'basis', 'source', 'openReason', 'note'] as const;
  onlyFields(data, ['title', ...optional], '正文');
  const body: NodeBody = { title: requiredText(data.title, '标题') };
  for (const key of optional) {
    const text = optionalText(data[key], `正文 ${key}`);
    if (text !== undefined) body[key] = text;
  }
  return body;
}

/**
 * 校验引用类型属于三种已定义的关系。
 * @param value 待校验的关系类型
 * @returns 可保存的引用类型
 */
export function refKind(value: unknown): RefKind {
  if (value !== 'premise' && value !== 'example' && value !== 'conflict') {
    invalid('引用类型必须是 premise、example 或 conflict');
  }
  return value;
}

/**
 * 校验并复制引用目标，只接受树内节点或外部材料二选一，不解析宿主文件。
 * @param value 草稿或手稿提供的引用指向
 * @returns 带可选局部定位的独立引用目标
 */
export function refTarget(value: unknown): RefTarget {
  const data = record(value, '引用目标');
  onlyFields(data, ['nodeId', 'doc', 'part'], '引用目标');
  const part = optionalText(data.part, '引用局部定位');
  if ((data.nodeId !== undefined) === (data.doc !== undefined)) {
    invalid('引用目标须在节点 ID 与材料定位之间二选一');
  }
  const target: RefTarget = data.nodeId !== undefined
    ? { nodeId: requiredText(data.nodeId, '引用目标节点 ID') }
    : { doc: requiredText(data.doc, '引用材料定位') };
  if (part !== undefined) target.part = part;
  return target;
}

/**
 * 提取确认目标 ID，允许直接使用待确认项，但不采信其中的执行者、节点清单等展示信息。
 * @param value 人明确选择的确认目标或其待确认项
 * @returns 仅含正式确认目标定位的独立对象
 */
export function confirmTarget(value: unknown): ConfirmTarget {
  const data = record(value, '确认目标');
  if ((data.revisionId !== undefined) === (data.seedNodeId !== undefined)) {
    invalid('确认目标须在形成记录与导入判断之间二选一');
  }
  return data.revisionId !== undefined
    ? { revisionId: requiredText(data.revisionId, '形成记录 ID') }
    : { seedNodeId: requiredText(data.seedNodeId, '导入节点 ID') };
}

/**
 * 在同一写事务中定位一个已校验 ID 指向的现有节点。
 * @param transaction 当前单树事务
 * @param id 节点的稳定 ID
 * @returns 该事务看到的原节点，供后续校验而非就地修改
 * @throws CognitionError 节点不存在（missing）
 */
export async function requireNode(transaction: WriteTransaction, id: NodeId): Promise<CognitionNode> {
  const node = await transaction.readNode(id);
  if (node === null) throw new CognitionError('missing', `节点 ${id} 不存在`);
  return node;
}
