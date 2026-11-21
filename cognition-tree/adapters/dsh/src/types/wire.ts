/**
 * 服务端线协议。客户端只依赖此处的常量/类型，不加载宿主或 worker。
 * 人侧：Connection 的 signed-cookie + Host/Origin + owner 检查在 exact Fetch 路由前完成。
 * AI：七个具名工具固定 ai；仅人可确认，DSH 的人/AI 入口都不开放手稿导入。身份不是请求参数。
 */
import type { OpInput, OpName, OpOutput } from '@cognition-tree/kernel/catalog/contracts';
import type { Revision } from '@cognition-tree/kernel/types';

export const CALL_PATH = '/api/cognition-tree/call';
export const WATCH_PATH = '/api/cognition-tree/watch';
/** 当前已绑定工作区的只读导航目录；不是针对某一棵树的领域操作。 */
export const TREES_PATH = '/api/cognition-tree/trees';

/** 每棵树只显示稳定标识与实际根的问题；旧库根 ID 不必等于文件中的树 ID。 */
export interface WorkspaceTreeItem { treeId: string; rootId: string; rootQuestion: string }
/** 仅含本工作区的树；可安全辨认但读取失败的候选单列，避免把部分目录伪装成完整结果。 */
export interface WorkspaceTreeDirectory { trees: WorkspaceTreeItem[]; unavailable: string[] }
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export const AI_TOOLS = {
  createTree: 'cognition_tree_create_tree',
  addBranch: 'cognition_tree_add_branch',
  decideNode: 'cognition_tree_decide_node',
  readView: 'cognition_tree_read_view',
  readNode: 'cognition_tree_read_node',
  readHistory: 'cognition_tree_read_history',
  readUnconfirmed: 'cognition_tree_read_unconfirmed',
} as const;
export type AiOp = keyof typeof AI_TOOLS;

/** DSH 只开放七项日常意图与人确认；内核保留的自举操作不属于此宿主协议。 */
export type UiOp = AiOp | 'confirm';

/** sessionId 只是宿主会话定位符；工作区必须由其可信 header 经宿主 registry 解析。 */
export type UiCall = { [K in UiOp]: { sessionId: string; op: K; input: OpInput[K] } }[UiOp];
export type CallResult<K extends OpName = OpName> =
  | { ok: true; value: OpOutput[K] }
  | { ok: false; error: { code: string; message: string } };

/** SSE change 只在后台确认提交后发出，不含工作区路径；首帧 ready 是 {sessionId}。 */
export interface ChangeNotice { treeId: string; stamp: number; revisions: Revision[] }

/** 只在当前连接通知、不存回放。重连后客户端须重读；慢消费者断开而不阻塞提交。 */
export const WATCH_EVENTS = { ready: 'ready', change: 'change' } as const;
