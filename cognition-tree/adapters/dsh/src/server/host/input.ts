/** 仅校验传输形状和身份边界；正文、树形、决定与查询预算仍由唯一的内核校验。 */
import type { OpInput } from '@cognition-tree/kernel/catalog/contracts';
import { CognitionError } from '@cognition-tree/kernel/types';
import type { AiOp, UiCall, UiOp } from '../../types/wire';

/** DSH 的显式入口白名单，不随内核新增操作自动扩大；手稿 bootstrapTree 不在其中。 */
const FIELDS: Record<UiOp, { required: string[]; optional?: string[] }> = {
  createTree: { required: ['treeId', 'rootQuestion'] },
  addBranch: { required: ['treeId', 'placement', 'draft'] },
  decideNode: { required: ['treeId', 'nodeId', 'decision'] },
  confirm: { required: ['treeId', 'target'] },
  // includeDetails 仅作为 readView 的可选布尔透传；详细模式的投影、计费与续读由内核守。
  readView: { required: ['treeId', 'focus', 'expand', 'budget', 'onLimit'], optional: ['cursor', 'includeDetails'] },
  readNode: { required: ['treeId', 'nodeId'] },
  readHistory: { required: ['treeId', 'limit'], optional: ['nodeId', 'after'] },
  readUnconfirmed: { required: ['treeId', 'by', 'limit'], optional: ['after'] },
};

/** 拒绝数组与非普通对象。@param value 已解析 JSON 或模型参数。 */
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** 只接受列出的字段，包含 actor/path/cwd/identity 的额外字段一律拒绝。@param value 参数对象。@param required 必传键。@param optional 可选键。 */
export function exactObject(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new CognitionError('invalid', '参数字段不符合认知树操作契约；身份与路径必须由宿主绑定。');
  }
}

/** 枚举八项已授权意图（建树替代自举），不允许任意 dispatch 名。@param value 请求中的 op。 */
export function isOp(value: unknown): value is UiOp {
  return typeof value === 'string' && Object.hasOwn(FIELDS, value);
}

/** 检查 ID 定位符的有界字符串形状，不把它解释成路径或凭证。@param value 会话 ID。 */
export function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new CognitionError('invalid', '必须选择有效的宿主会话。');
  }
  return value;
}

/** 校验顶层具名参数，领域细节交给内核。@param op 已枚举意图。@param input 原始参数。 */
export function parseInput<K extends UiOp>(op: K, input: unknown): OpInput[K] {
  const fields = FIELDS[op];
  exactObject(input, fields.required, fields.optional);
  return input as unknown as OpInput[K];
}

/** AI 读取视图整项省略 budget 时的唯一默认；只补这一处，不改变人侧必传契约。 */
export const AI_READ_VIEW_BUDGET = { maxScans: 400, maxNodes: 24, maxBytes: 4000 } as const;

/**
 * AI 工具入口：readView 允许整项省略 budget，此时补一组显式三项交给内核。
 * 只要 budget 键存在（包括 null、缺项、非法值）就不改写；字段、身份与工作区保护仍由 parseInput 负责。
 * includeDetails 原样透传，不补缺省：省略与 false 都由内核按同一默认解释。
 * @param op 已枚举的 AI 意图。
 * @param input 模型给出的原始参数。
 * @returns 可交给 runtime/kernel 的具名参数。
 */
export function parseAiInput<K extends AiOp>(op: K, input: unknown): OpInput[K] {
  if (op === 'readView' && record(input) && !Object.hasOwn(input, 'budget')) {
    return parseInput(op, { ...input, budget: { ...AI_READ_VIEW_BUDGET } });
  }
  return parseInput(op, input);
}

/** 人侧入口只接会话定位符和操作，不能选择执行者或工作区。@param value 请求 JSON。 */
export function parseUiCall(value: unknown): UiCall {
  exactObject(value, ['sessionId', 'op', 'input']);
  const sessionId = requireSessionId(value.sessionId);
  if (!isOp(value.op)) throw new CognitionError('invalid', '未知认知树操作。');
  return { sessionId, op: value.op, input: parseInput(value.op, value.input) } as UiCall;
}
