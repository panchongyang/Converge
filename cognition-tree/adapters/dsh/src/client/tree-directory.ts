/**
 * 当前工作区的树目录读取（客户端）：同源 GET，只带可信 sessionId。
 *
 * 职责：实现侧栏“全部树”列表的只读数据源。服务端把 sessionId 解析成工作区并只返回该工作区的树；
 * 客户端不传路径、不缓存目录、不轮询，每次由挂载、返回或手动刷新触发一次读取。
 * 失败：沿用插件错误信封的 code/message；形状不符归为 unknown，不把半份结果当完整目录。
 * 边界：不做写操作，不判断树内容；目录已带实际根，进入某棵树时直接用该根，不再二次读取。
 */
import { TREES_PATH, type WorkspaceTreeDirectory, type WorkspaceTreeItem } from '../types/wire';
import { wireError } from './transport';

/** fetch 替身注入点；测试用，不改变生产同源请求。 */
export interface DirectoryReaderOptions {
  fetchImpl?: typeof fetch;
}

/** 只读目录输出：可辨认的树与“读不到根问题”的树 ID 分开，调用方不会把二者混成同一状态。 */
export type TreeDirectory = WorkspaceTreeDirectory;

/** 面板显示用的错误形状；与共享 UI 的 UiError 结构一致，不引入 UI 运行时。 */
export interface DirectoryError {
  code: string;
  message: string;
}

/** 把任意异常整理成可显示的 code/message；未知异常不冒充业务结论。 */
export function toDirectoryError(e: unknown): DirectoryError {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return { code: (e as { code: string }).code, message: e instanceof Error ? e.message : String(e) };
  }
  return { code: 'unknown', message: e instanceof Error ? e.message : String(e) };
}

/** 目录项解析结果：完整可进入的树，或只能按 ID 列为暂时不可用的候选。 */
type ReadEntry = { item: WorkspaceTreeItem } | { unavailable: string } | null;

/**
 * 规范化一个目录项。
 * 树 ID 是辨认候选的最低要求；缺根或根问题时不把半成品放进 trees，
 * 以免列表出现“可点击但进不去”的行。
 * @param value 服务端目录里的一项
 * @returns 完整项、不可用候选 ID，或无法辨认时为 null
 */
function readItem(value: unknown): ReadEntry {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const treeId = typeof item.treeId === 'string' ? item.treeId.trim() : '';
  if (treeId === '') return null;
  // 空白只能用来判缺失；路由所用的已存根 ID 与根问题原文不能在客户端重写。
  const rootId = typeof item.rootId === 'string' ? item.rootId : '';
  const rootQuestion = typeof item.rootQuestion === 'string' ? item.rootQuestion : '';
  if (!rootId.trim() || !rootQuestion.trim()) return { unavailable: treeId };
  return { item: { treeId, rootId, rootQuestion } };
}

/**
 * 校验并规范化目录正文（纯逻辑）。
 * @param text 服务端响应正文
 * @returns 完整项进 trees，缺根/根问题的候选进 unavailable；无 ID 的条目丢弃，同 ID 只保留第一次
 * @throws DirectoryError 正文不是 JSON、不是成功信封或 trees 不是数组
 */
export function parseTreeDirectory(text: string): WorkspaceTreeDirectory {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw wireError('unknown', '树列表返回了无法解析的结果。');
  }
  if (!raw || typeof raw !== 'object') throw wireError('unknown', '树列表返回了无法识别的结果。');
  const envelope = raw as Record<string, unknown>;
  if (envelope.ok !== true) {
    const failure = envelope.ok === false ? (envelope.error as Record<string, unknown> | undefined) : undefined;
    const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'unknown';
    const message =
      typeof failure?.message === 'string' && failure.message !== '' ? failure.message : '读取树列表失败。';
    throw wireError(code, message);
  }
  const value = envelope.value;
  if (!value || typeof value !== 'object') throw wireError('unknown', '树列表返回了无法识别的结果。');
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.trees)) throw wireError('unknown', '树列表返回了无法识别的结果。');

  const trees: WorkspaceTreeItem[] = [];
  const seen = new Set<string>();
  const unavailable: string[] = [];
  for (const entry of body.trees) {
    const parsed = readItem(entry);
    if (!parsed) continue;
    if ('item' in parsed) {
      if (seen.has(parsed.item.treeId)) continue;
      seen.add(parsed.item.treeId);
      trees.push(parsed.item);
      // 同一 ID 先以不可用出现、后以完整项出现时，以完整项为准。
      const at = unavailable.indexOf(parsed.item.treeId);
      if (at >= 0) unavailable.splice(at, 1);
    } else if (!seen.has(parsed.unavailable) && !unavailable.includes(parsed.unavailable)) {
      unavailable.push(parsed.unavailable);
    }
  }
  if (Array.isArray(body.unavailable)) {
    for (const id of body.unavailable) {
      if (typeof id !== 'string') continue;
      const candidate = id.trim();
      // 不可用与可点击互斥：trees 里已经能进入的 ID 不再重复列成不可用。
      if (candidate !== '' && !seen.has(candidate) && !unavailable.includes(candidate)) unavailable.push(candidate);
    }
  }
  // 有候选却一个都辨认不出来：这是形状坏，不是“工作区为空”，不能显示成空目录。
  if (body.trees.length > 0 && trees.length === 0 && unavailable.length === 0) {
    throw wireError('unknown', '树列表返回了无法识别的结果。');
  }
  return { trees, unavailable };
}

/**
 * 读取当前会话工作区的树目录。
 * @param sessionId 宿主给出的可信会话；空白直接拒绝，不退化成默认工作区
 * @param options 测试注入的 fetch；缺省用全局 fetch
 * @returns 规范化后的目录
 * @throws DirectoryError 网络失败、HTTP 失败或信封不符
 */
export async function readTreeDirectory(
  sessionId: string,
  options: DirectoryReaderOptions = {},
): Promise<TreeDirectory> {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id === '') throw wireError('invalid', '没有当前会话，无法读取树列表。');
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const url = TREES_PATH + '?sessionId=' + encodeURIComponent(id);
  let response: Response;
  try {
    // 目录必须能被人手动刷新看到别的会话刚建的树：显式绕过浏览器缓存，不做后台轮询。
    response = await doFetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw wireError('unknown', '无法连接认知树服务，请稍后刷新重试。');
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw wireError('unknown', '读取树列表响应失败，请稍后刷新重试。');
  }
  const directory = parseTreeDirectory(text);
  if (!response.ok) {
    throw wireError('unknown', '树列表响应状态与正文不一致，请稍后刷新重试。');
  }
  return directory;
}
