/**
 * 树入口的纯逻辑与文案：草稿校验、打开已知树的输入判定、失败说明。
 *
 * 职责：把“缺什么、为什么不能提交”整理成一句可显示的话，供 TreeEntry 与测试共用；
 * 让“创建树”这个词只在这里定义一次。
 * 边界：不访问 React、DOM 或宿主。树 ID 的字符规则由环境的 TreeAccess 最终裁决
 *（DSH 端与 server/storage/files.ts 的数据库文件名规则一致），这里只挡空输入。
 * 依据：人的决定——工作区面板只留一个建树入口，按已知 ID 打开/切换，不做列表。
 */
import { ERROR_MEANING, type UiError } from '../../utils/errors';

/** 树入口上出现的动作词；create 对应 createTree 操作的显示词。 */
export const TREE_ENTRY_COPY = {
  /** 新建一棵树。 */
  create: '创建树',
  /** 打开一棵已知 ID 的树。 */
  open: '打开',
  /** 顶栏常驻入口的短词。 */
  entry: '打开 / 新建',
  treeId: '树 ID',
  rootQuestion: '根问题',
} as const;

/** 空状态里对入口的说明；不出现“导入”“手稿”等另一种建树方式的暗示。 */
export const TREE_GENESIS_COPY = {
  action: '新建或打开树',
  desc: '用树 ID 和根问题新建一棵树；也可以按已知 ID 打开这个工作区里已有的树。',
  note: '创建只在树 ID 尚不存在时生效，不覆盖已有树；打开会先读取树的根核对，不修改数据。',
} as const;

/** 新建树表单的原始输入。 */
export interface TreeDraft {
  /** 目标树 ID，也是新根节点 ID。 */
  treeId: string;
  /** 根问题原文；非空白，作为新树唯一根节点的标题。 */
  rootQuestion: string;
}

/**
 * 新建树表单能否提交。
 * @param draft 表单原文
 * @returns 第一条不可提交的原因；可提交时为 null
 */
export function treeDraftIssue(draft: TreeDraft): string | null {
  if (draft.treeId.trim() === '') return '树 ID 不能为空。';
  if (draft.rootQuestion.trim() === '') return '根问题不能为空。';
  return null;
}

/**
 * 打开已知树的输入能否提交。
 * @param treeId 表单原文
 * @returns 空输入的原因；可提交时为 null
 */
export function openTreeIssue(treeId: string): string | null {
  return treeId.trim() === '' ? '请输入已知的树 ID。' : null;
}

/**
 * 当前树不存在时的空状态标题。只说明这个 ID 没找到，不宣称整个工作区没有树：
 * 多树工作区里别的树可能存在，只是这里不列清单。
 * @param treeId 本次尝试显示的树 ID
 */
export function missingTreeTitle(treeId: string): string {
  return `没有找到树 ${treeId}`;
}

/**
 * 把端口错误整理成一句可显示的失败原因。
 * @param error 带 code 的 UI 错误
 * @returns 原文加该 code 对树的影响说明；未知 code 只显示原文
 */
export function treeErrorText(error: UiError): string {
  const meaning = ERROR_MEANING[error.code];
  return meaning ? `${error.message} ${meaning}` : error.message;
}
