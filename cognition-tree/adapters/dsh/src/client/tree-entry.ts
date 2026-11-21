/**
 * 面板的树入口（纯逻辑）：树 ID 规则、新建树、进入目录行与会话换绑。
 *
 * 职责：
 * - 树 ID 校验：与 `server/storage/files.ts` 的 databaseName 同一条文件名规则（1–64 位、
 *   首位字母或数字、其余字母/数字/下划线/连字符、拒绝 Windows 设备名）。服务端仍最终裁决；
 *   客户端先挡一次是为了在输入框旁直接说明原因。
 * - 进入：目录已报告实际根，直接带着它进入，不再逐树 readView(root) 重取。
 * - 新建：只发 createTree(treeId, rootQuestion)；同名冲突由内核拒绝，这里不先“查重后覆盖”。
 *   创建成功时根 ID 按契约等于树 ID，调用方直接进入，不把二次读根失败误报成新建失败。
 * - 换绑：宿主换到另一个会话时回到该会话的“全部树”目录，不把上一棵树带过去。
 *
 * 边界：不缓存树内容、本模块不列树（目录由 Panel 经 trees 路由读取）、不改名或删除；
 * 调用都来自人的明确操作。
 */
import type { NodeId, TreeId } from '@cognition-tree/kernel/types';
import type { CognitionClient } from '@cognition-tree/ui/types/ports';
import type { SessionState } from './session';
import { wireError } from './transport';

/** 面板本次显示绑定的会话；treeId 缺省表示“全部树”目录，有值时进入该树。 */
export interface PanelView {
  sessionId: string;
  treeId?: TreeId;
}

/**
 * 校验树 ID；返回第一处不合规的原因。
 * @param treeId 人输入的树 ID
 * @returns 可直接显示的原因；合规时为 null
 */
export function treeIdIssue(treeId: string): string | null {
  if (treeId.length === 0) return '树 ID 不能为空。';
  if (treeId.length > 64) return '树 ID 最长 64 个字符。';
  if (!/^[a-z0-9]/i.test(treeId)) return '树 ID 必须以字母或数字开头。';
  if (/[^a-z0-9_-]/i.test(treeId)) return '树 ID 只能包含字母、数字、下划线或连字符。';
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(treeId)) return '这个名称是系统保留设备名，请换一个树 ID。';
  return null;
}

/**
 * 由人新建一棵树。
 * @param client 当前会话的认知端口
 * @param treeId 尚未存在的树 ID，也是新根节点 ID
 * @param rootQuestion 根问题原文；非空白
 * @returns 内核确认的树 ID；同名时不覆盖，而是抛出 invalid
 */
export async function createTree(
  client: CognitionClient,
  treeId: string,
  rootQuestion: string,
): Promise<TreeId> {
  const issue = treeIdIssue(treeId);
  if (issue) throw wireError('invalid', issue);
  if (rootQuestion.trim() === '') throw wireError('invalid', '根问题不能为空。');
  return client.call('createTree', { treeId, rootQuestion });
}

/**
 * 新建并进入：createTree 成功后按契约以 treeId 作为新根交给调用方，不再二次读取。
 * 创建失败时不会调用 enter，调用方可以原样重试同一份表单。
 * @param client 当前会话的认知端口
 * @param treeId 尚未存在的树 ID
 * @param rootQuestion 根问题原文，非空白
 * @param enter 创建成功后的进入回调，接收树 ID 与根 ID
 * @throws 带 code 的业务错误：参数不合规、同名冲突或保存失败
 */
export async function createAndEnter(
  client: CognitionClient,
  treeId: string,
  rootQuestion: string,
  enter: (treeId: TreeId, rootId: NodeId) => void,
): Promise<void> {
  const created = await createTree(client, treeId, rootQuestion);
  enter(created, created);
}

/**
 * 宿主会话变化后本次显示该绑定的视图。
 * 只认唯一实时会话；与当前视图同一会话时返回 null（不重挂、不丢已选树）。
 * 换到另一个会话时回到该工作区的“全部树”列表，不默认任何树，也不把上一棵树带过去。
 * @param current 当前冻结的视图；尚未绑定时为 null
 * @param native 宿主当前的会话汇总
 * @returns 需要改绑的视图（不带 treeId）；不需要或会话不唯一时为 null
 */
export function rebindForSession(current: PanelView | null, native: SessionState): PanelView | null {
  if (native.status !== 'ready') return null;
  if (current && current.sessionId === native.sessionId) return null;
  return { sessionId: native.sessionId };
}

/**
 * 共享 App 的挂载键。refresh 必须参与：重新打开同一棵树时树 ID 与初始节点都可能没变，
 * 只靠树 ID 不会重挂，也就不会重新读取（SSE 可能漏事件）。
 * @param view 本次显示的视图
 * @param jump 当前跳转意图；缺省或没有节点时只留 none
 * @returns 稳定字符串键；绑定或世代变化时不同
 */
export function panelMountKey(
  view: PanelView & { refresh?: number; initialNodeId?: string },
  jump?: { nodeId?: string; seq: number } | null,
): string {
  return [
    view.sessionId,
    view.treeId ?? '',
    String(view.refresh ?? 0),
    view.initialNodeId ?? '',
    jump?.nodeId ? 'jump-' + jump.seq : 'none',
  ].join(':');
}

/**
 * 从“全部树”目录进入一棵树。
 * 只有仍停在同一会话目录时才接受；人已换会话或已在看树时丢弃迟到的打开结果，
 * 不把旧会话的 treeId/rootId 串进当前视图。refresh 递增让 App 以新挂载键读回实际根。
 * @param current 当前视图；目录视图没有 treeId
 * @param sessionId 发起打开时的可信会话
 * @param treeId 要显示的树
 * @param rootId 目录项报告的实际根
 * @returns 进入树的视图；不在原目录时为 null
 */
export function enterFromDirectory<T extends PanelView & { initialNodeId?: string; refresh?: number }>(
  current: T | null,
  sessionId: string,
  treeId: TreeId,
  rootId: NodeId,
): T | null {
  if (!current || current.sessionId !== sessionId || current.treeId !== undefined) return null;
  return {
    ...current,
    treeId,
    initialNodeId: rootId,
    refresh: (current.refresh ?? 0) + 1,
  };
}
