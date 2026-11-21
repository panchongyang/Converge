/**
 * 聊天里两条 AI 写入工具的卡片投影（纯逻辑）。
 *
 * 职责：把宿主交给 toolview 的调用块翻译成可读的提议/变更摘要，并算出“去哪棵树、
 * 哪个节点看”。只登记 addBranch 与 decideNode 两个写入工具；读工具不挂卡，未知工具
 * 一律返回 null，避免卡片影响无关调用。
 *
 * 真实 ABI：`block.args` 是宿主 `PartialArguments`（不是普通对象）。字段要用它的
 * `text(key)` / `value(key)` 访问器在渲染时读取；准备中的视图会就地增长，不能按
 * block/args 的对象身份缓存结果。结果块用 `kind:'tool-result'` 与 `isError` 表示
 * 成功/失败，没有 `phase:'result'`。
 *
 * 边界：
 * - 不确认、不自举：卡片没有调用 confirm/bootstrapTree 的入口，确认只能由人在正式
 *   面板的阅读栏里点击；这里给出的目标只用于打开面板与选中。
 * - “去确认”只给成功结果，且必须带本工具自己的 presentationMeta（kind/op/treeId/nodeId
 *   齐全）；失败或进行中只显示状态，绝不把旧变更当成本次可确认目标。
 * - 树/节点 ID 只取该调用自己的参数或 meta；不拿当前会话或当前树顶替，
 *   sessionId 缺失时也不猜。
 */
import { AI_TOOLS } from '../types/wire';
import { normalizeId } from './session';

/** 只登记写入工具；其余四个读工具没有“待确认/变更”语义。 */
export const WRITE_TOOL_NAMES = [AI_TOOLS.addBranch, AI_TOOLS.decideNode] as const;

export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

/** 宿主 PartialArguments 中本卡片使用到的访问器；不缓存、不展开成普通对象。 */
export interface ArgsView {
  /**
   * 读取字符串字段（流式时返回已到达的前缀）。
   * @param key 顶层参数名
   */
  text(key: string): string | undefined;
  /**
   * 读取已闭合的非字符串字段。
   * @param key 顶层参数名
   */
  value(key: string): unknown;
}

/** 宿主 chat 传给 toolview 的块；只取本卡片需要的字段。 */
export interface ToolBlock {
  /** 运行阶段的判别字段；preparing / start。结果块没有 phase。 */
  phase?: string;
  /** 最终结果块的判别字段。 */
  kind?: string;
  /** 工具名；结果块可能为空字符串。 */
  name?: string;
  /** PartialArguments 参数视图（准备中会就地增长）。 */
  args?: unknown;
  /** 结果正文块，通常是服务端 render 出的摘要文本。 */
  content?: unknown;
  /** 服务端 presentationMeta；只取本插件成功结果里的精确目标。 */
  meta?: unknown;
  /** 结果块是否失败；只有明确 false 才算成功。 */
  isError?: boolean;
}

/** 卡片状态：进行中、失败、成功；失败不暗示已保存。 */
export type CardStatus = 'preparing' | 'running' | 'failed' | 'succeeded';

/** 卡片可展示的投影。 */
export interface WriteCardModel {
  /** 工具名，用来在卡片上区分提议与变更。 */
  tool: WriteToolName;
  /** 提议：addBranch；变更：decideNode。 */
  kind: 'proposal' | 'change';
  /** 状态。 */
  status: CardStatus;
  /** 状态文案；失败时明确“未保存”。 */
  statusText: string;
  /** 树 ID；调用未带齐参数时为 null，卡片此时只能给出降级说明。 */
  treeId: string | null;
  /** 成功结果 meta 里的精确节点；“去确认”只认它。 */
  nodeId: string | null;
  /** 追问时的上下文节点；addBranch 指向父节点/被替代节点，decideNode 指向被决定的节点。 */
  contextNodeId: string | null;
  /** 一句话标题。 */
  title: string;
  /** 选择依据/理由摘要，可能为空。 */
  detail: string;
}

/** 安全读对象字段。 */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 只接受非空白字符串。 */
function str(value: unknown): string | null {
  return normalizeId(value);
}

/** 判断参数视图是否真的带访问器；坏块返回 null，不抛错。 */
function argsView(value: unknown): ArgsView | null {
  const view = record(value);
  if (!view || typeof view.text !== 'function' || typeof view.value !== 'function') return null;
  return view as unknown as ArgsView;
}

/** 参数里的字符串字段；每次渲染都重新读，准备中的增长能被看到。 */
function argText(args: ArgsView | null, key: string): string | null {
  if (!args) return null;
  try {
    return str(args.text(key));
  } catch (error) {
    return null;
  }
}

/** 参数里已闭合的对象字段；未闭合/形状不符时为 null。 */
function argObject(args: ArgsView | null, key: string): Record<string, unknown> | null {
  if (!args) return null;
  try {
    return record(args.value(key));
  } catch (error) {
    return null;
  }
}

/** 本工具在 wire 上的操作名。 */
function opOf(tool: WriteToolName): 'addBranch' | 'decideNode' {
  return tool === AI_TOOLS.addBranch ? 'addBranch' : 'decideNode';
}

/**
 * 成功结果上属于本工具的精确目标。
 * @param block 结果块
 * @param tool 注册的工具名
 * @returns treeId/nodeId；失败、未结束或 meta 不是本工具时为 null
 */
function exactTarget(block: ToolBlock | null | undefined, tool: WriteToolName): { treeId: string; nodeId: string } | null {
  if (!block || block.kind !== 'tool-result' || block.isError !== false) return null;
  const meta = record(block.meta);
  if (!meta || meta.kind !== 'cognition-tree' || meta.op !== opOf(tool)) return null;
  const treeId = str(meta.treeId);
  const nodeId = str(meta.nodeId);
  return treeId && nodeId ? { treeId, nodeId } : null;
}

/** 把块正文压成一段可展示文本；只取 text 类型分块。 */
function textOf(content: unknown, limit = 280): string {
  const parts = Array.isArray(content) ? content : [];
  const out = parts
    .map((part) => {
      const p = record(part);
      return p && p.type === 'text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return out.length > limit ? out.slice(0, limit) + '…' : out;
}

/** addBranch 的 draft 标题/说明；draft 未闭合时只显示已有参数。 */
function draftText(args: ArgsView | null): { title: string; detail: string } {
  const draft = argObject(args, 'draft');
  const body = draft ? record(draft.body) : null;
  const title = body ? str(body.title) ?? '' : '';
  const detail = body ? str(body.note) ?? str(body.basis) ?? str(body.source) ?? '' : '';
  return { title, detail };
}

/** decideNode 的中文动作名。 */
function decisionLabel(decision: unknown): string {
  const d = record(decision);
  if (!d) return '变更';
  switch (d.type) {
    case 'prune':
      return '剪除';
    case 'revive':
      return '复活';
    case 'setOpenOrKeep':
      return '改状态';
    case 'applyReplacement':
      return '执行替代';
    default:
      return '变更';
  }
}

/** 依宿主回执展示阶段，不把失败或中断一概说成已回滚。@param block 工具调用或结果块 */
function statusOf(block: ToolBlock | null | undefined): { status: CardStatus; text: string } {
  if (block?.kind === 'tool-result') {
    if (block.isError === false) return { status: 'succeeded', text: '已保存，可另行确认' };
    return { status: 'failed', text: '写入未取得成功回执，请到面板核对当前状态' };
  }
  if (block?.phase === 'start') return { status: 'running', text: '写入请求进行中' };
  return { status: 'preparing', text: 'AI 正在组织这次写入' };
}

/**
 * 解释一个工具块。每次调用都重新读 PartialArguments，不做缓存。
 * @param block 宿主 toolview owner props 里的块
 * @param toolName 注册 key 对应的工具名；块里缺 name 时用它补
 * @returns 写入卡投影；不是本插件的写入工具时返回 null
 */
export function readWriteCard(block: ToolBlock | null | undefined, toolName?: string): WriteCardModel | null {
  const name = str(toolName) ?? (block ? str(block.name) : null);
  if (name !== AI_TOOLS.addBranch && name !== AI_TOOLS.decideNode) return null;
  const tool = name as WriteToolName;
  const args = argsView(block?.args);
  const exact = exactTarget(block, tool);
  const treeId = exact?.treeId ?? argText(args, 'treeId');
  const content = textOf(block?.content);
  const { status, text: statusText } = statusOf(block);

  if (tool === AI_TOOLS.addBranch) {
    const { title, detail } = draftText(args);
    const placement = argObject(args, 'placement');
    const contextNodeId = placement ? str(placement.replacesId) ?? str(placement.parentId) : null;
    const fallbackTitle = placement && str(placement.replacesId) ? '提出替代候选' : '提出新判断';
    return {
      tool,
      kind: 'proposal',
      status,
      statusText,
      treeId,
      nodeId: exact?.nodeId ?? null,
      contextNodeId: exact?.nodeId ?? contextNodeId,
      title: title || fallbackTitle,
      detail: detail || content,
    };
  }

  const decision = argObject(args, 'decision');
  const contextNodeId = argText(args, 'nodeId');
  const label = decisionLabel(decision);
  const reason = decision ? str(decision.reason) ?? str(decision.reviveWhen) ?? '' : '';
  const title = contextNodeId ? `${label} ${contextNodeId}` : label;
  return {
    tool,
    kind: 'change',
    status,
    statusText,
    treeId,
    nodeId: exact?.nodeId ?? null,
    contextNodeId,
    title,
    detail: reason || content,
  };
}

/** 卡片上三个动作的落点；null 表示该动作此刻不可用。 */
export interface CardActionTarget {
  /** 仅打开面板：缺少明确节点时也能看树。 */
  open: { treeId: string; nodeId?: string } | null;
  /** 追问：打开面板并选中这次写入的上下文节点；缺失时为 null。 */
  context: { treeId: string; nodeId: string } | null;
  /** 去确认：只在成功结果带本工具精确 meta 时提供。 */
  focus: { treeId: string; nodeId: string } | null;
}

/**
 * 计算卡片动作。只返回“打开/选中”目标，不返回任何写操作。
 * @param model 卡片投影
 * @param sessionId 卡片所属会话；缺失时所有动作都不可用
 * @returns 动作落点
 */
export function cardActionTarget(model: WriteCardModel, sessionId: string | null | undefined): CardActionTarget {
  const session = normalizeId(sessionId);
  const tree = normalizeId(model.treeId);
  if (!session || !tree) return { open: null, context: null, focus: null };
  const node = model.status === 'succeeded' ? normalizeId(model.nodeId) : null;
  const context = normalizeId(model.contextNodeId);
  return {
    open: { treeId: tree, ...(context ? { nodeId: context } : {}) },
    context: context ? { treeId: tree, nodeId: context } : null,
    focus: node ? { treeId: tree, nodeId: node } : null,
  };
}
