/**
 * 查询内部的入参护栏；只依赖领域契约，不推定焦点、展开范围或执行者缺省值。
 * 本模块不读存储；公开入口先校验，再打开快照。
 */
import { CognitionError } from '../types/index';
import type { Budget, ConfirmTarget, Depth, Expand, RevisionActor } from '../types/index';

/** 视图焦点只能显式选根，或指定一个稳定节点 ID。 */
export type Focus = string | { root: true };

/**
 * 拒绝非对象输入，供其余查询校验复用。
 * @param value 尚未可信的入参
 * @param name 面向人的参数名
 */
export function object(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CognitionError('invalid', `${name}必须是对象。`);
  }
}

/**
 * 校验稳定 ID，不裁剪或改写调用方给出的值。
 * @param value 待查 ID
 * @param name 面向人的 ID 名称
 */
export function id(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CognitionError('invalid', `${name}必须是非空字符串。`);
  }
}

/**
 * 校验离散计数，拒绝 NaN、无穷及无法精确推进的整数。
 * @param value 待校验计数
 * @param name 面向人的计数名称
 * @param minimum 允许的最小值
 */
function integer(value: unknown, name: string, minimum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new CognitionError('invalid', `${name}必须是大于等于 ${minimum} 的安全整数。`);
  }
}

/**
 * 校验显式深度。
 * @param value 边数，或显式直到叶子的 leaf
 * @param name 参数名
 */
function depth(value: unknown, name: string): asserts value is Depth {
  if (value !== 'leaf') integer(value, name, 0);
}

/**
 * 校验视图参数；所有范围和预算均必传，续读预算可以改变。
 * @param treeId 所选树 ID
 * @param focus 显式根或节点焦点
 * @param expand 展开范围
 * @param budget 本页预算
 * @param onLimit 超限策略
 * @param cursor 首次省略，续读传上次原样返回的游标
 */
export function validateView(
  treeId: string,
  focus: Focus,
  expand: Expand,
  budget: Budget,
  onLimit: 'fold' | 'exact',
  cursor?: string,
): void {
  id(treeId, '树 ID');
  if (typeof focus === 'string') id(focus, '焦点 ID');
  else {
    object(focus, '焦点');
    if (Object.keys(focus).length !== 1 || focus.root !== true) {
      throw new CognitionError('invalid', '焦点须为节点 ID 或显式的 {root: true}。');
    }
  }
  object(expand, '展开参数');
  depth(expand.subtreeDepth, '初始深度');
  depth(expand.afterJumpDepth, '跳后深度');
  integer(expand.jumpHops, '引用跳数', 0);
  if (!['out', 'in', 'both'].includes(expand.direction)) {
    throw new CognitionError('invalid', '引用方向必须是 out、in 或 both。');
  }
  if (!['anchor', 'expanded'].includes(expand.jumpFrom)) {
    throw new CognitionError('invalid', '起跳范围必须是 anchor 或 expanded。');
  }
  object(budget, '读取预算');
  integer(budget.maxScans, '扫描预算', 1);
  integer(budget.maxNodes, '节点预算', 1);
  integer(budget.maxBytes, '字节预算', 1);
  if (onLimit !== 'fold' && onLimit !== 'exact') {
    throw new CognitionError('invalid', '超限策略必须是 fold 或 exact。');
  }
  if (cursor !== undefined) id(cursor, '续读游标');
}

/**
 * 校验页大小；额外的一条只用来探测下一页，也由存储索引有界返回。
 * @param limit 本页条数，必须显式给出
 */
export function pageLimit(limit: unknown): asserts limit is number {
  integer(limit, '页大小', 1);
  if (limit === Number.MAX_SAFE_INTEGER) {
    throw new CognitionError('invalid', '页大小须容得下一条有界的下一页探测。');
  }
}

/**
 * 校验未确认索引筛选，不提供默认执行者。
 * @param by 执行者种类的非空子集
 */
export function actors(by: unknown): asserts by is RevisionActor[] {
  if (!Array.isArray(by) || by.length === 0 || by.some((item) => !['human', 'ai', 'import'].includes(item))) {
    throw new CognitionError('invalid', '待确认筛选须为 human、ai、import 的非空子集。');
  }
}

/**
 * 校验未确认页的末项键，禁止把两个目标混在一个对象中。
 * @param target 上一页末项对应的确认目标
 */
export function confirmTarget(target: unknown): asserts target is ConfirmTarget {
  object(target, '分页起点');
  if (Object.keys(target).length !== 1) {
    throw new CognitionError('invalid', '分页起点须且只能指定 revisionId 或 seedNodeId。');
  }
  if ('revisionId' in target) id(target.revisionId, '修订 ID');
  else if ('seedNodeId' in target) id(target.seedNodeId, '导入节点 ID');
  else throw new CognitionError('invalid', '分页起点不是确认目标。');
}

/**
 * 生成与属性插入顺序无关的查询身份；预算不是范围的一部分。
 * @param treeId 所选树 ID
 * @param focus 显式焦点
 * @param expand 展开范围
 * @param onLimit 超限策略
 * @param omitRefScope 本查询是否采用零跳数省略投影
 * @param modelWire 本查询是否使用宿主模型表示计费；与原生 JSON 不混续
 * @param includeDetails 是否为每个节点投影详情；不同模式不能混续
 * @returns 仅供游标绑定校验的内部键
 */
export function viewKey(
  treeId: string, focus: Focus, expand: Expand, onLimit: 'fold' | 'exact',
  omitRefScope: boolean, modelWire: boolean, includeDetails: boolean,
): string {
  return JSON.stringify([
    treeId, typeof focus === 'string' ? ['node', focus] : ['root'],
    expand.subtreeDepth, expand.jumpHops, expand.direction, expand.jumpFrom, expand.afterJumpDepth,
    onLimit, omitRefScope, modelWire, includeDetails,
  ]);
}
