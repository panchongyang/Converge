/**
 * “全部树”列表的纯逻辑与文案。
 *
 * 职责：把服务工作区目录整理成可显示的行，并集中定义空、失败、部分不可用与新建树的文案；
 * 供 Directory 组件与测试共用，避免同一句话散在 JSX 里。
 * 边界：不访问 React、DOM、宿主或网络；不判断树是否存在，也不排序——顺序沿用服务端给出的目录。
 * 依据：人的决定——侧栏打开默认当前工作区的“全部树”列表，一行根问题主标题 + 树 ID，
 * 即使只有一棵树也先列表；列表是唯一建树入口；不做删除、改名。
 */
import type { TreeId } from '../../types/kernel';

/** 目录里的一棵树；rootId 是服务端报告的实际根，进入时直接使用它。 */
export interface DirectoryItem {
  /** 工作区内的树 ID，也是打开请求的唯一定位符。 */
  treeId: TreeId;
  /** 服务端报告的实际根；打开时直接用它，不再二次读根。 */
  rootId: string;
  /** 根问题原文；作为一行的主标题。 */
  rootQuestion: string;
}

/** 目录界面的固定文案；动作词与树入口测试保持同一套说法。 */
export const DIRECTORY_COPY = {
  title: '全部树',
  newTree: '新建树',
  refresh: '刷新',
  refreshing: '刷新中…',
  loading: '正在读取树列表…',
  loadingShort: '正在读取…',
  errorShort: '暂时读不到',
  emptyTitle: '这个工作区还没有认知树',
  emptyDesc: '认知树保存判断与依据。用树 ID 和根问题新建第一棵，之后可以在这里打开。',
  emptyAction: '新建第一棵树',
  errorTitle: '没能读取树列表',
  retry: '重试',
  unavailableRow: '暂不可用',
  unavailableNote: '根问题暂时读不到，这棵树先不在这里打开；稍后刷新再试。',
  unnamedQuestion: '（根问题暂时读不到）',
  createTitle: '新建一棵树',
  createHint: '树 ID 只在尚不存在时创建，不覆盖已有树；根问题作为新树唯一的根判断。',
  createSubmit: '创建并进入',
  cancel: '取消',
  treeId: '树 ID',
  rootQuestion: '根问题',
  workspace: '当前工作区',
} as const;

/**
 * 一行的主标题：根问题原文；空白时给出可读占位，不伪造内容。
 * @param item 目录项
 * @returns 去掉首尾空白后的根问题，或统一占位
 */
export function directoryItemTitle(item: DirectoryItem): string {
  const title = item.rootQuestion.trim();
  return title === '' ? DIRECTORY_COPY.unnamedQuestion : title;
}

/**
 * 只出现在 unavailable 里的树 ID，按原顺序去重。
 * 服务端可能把同一棵树同时放进 trees 和 unavailable；已经能显示的行不再重复。
 * @param items 已读到的树
 * @param unavailable 根问题暂时读不到的树 ID
 * @returns 需要单独列出的不可用树 ID
 */
export function unavailableOnly(items: readonly DirectoryItem[], unavailable: readonly string[]): TreeId[] {
  const known = new Set(items.map((item) => item.treeId));
  const seen = new Set<string>();
  const result: TreeId[] = [];
  for (const id of unavailable) {
    if (typeof id !== 'string' || id.trim() === '' || known.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 标题下的计数说明。
 * @param items 已读到的树数
 * @param unavailableOnlyCount 单独列出的不可用树数
 * @returns 一句话；没有树也没有不可用项时说明工作区为空
 */
export function directorySummary(items: number, unavailableOnlyCount: number): string {
  if (items === 0 && unavailableOnlyCount === 0) return '还没有树';
  const base = `共 ${items} 棵树`;
  return unavailableOnlyCount > 0 ? `${base}，${unavailableOnlyCount} 棵暂时读不到` : base;
}

/**
 * 空状态文案；“有树但都暂时读不到”不算空，仍列出不可用项与刷新。
 * @param itemCount 已读到的树数
 * @param unavailableOnlyCount 单独列出的不可用树数
 * @returns 空状态标题与说明；不空时为 null
 */
export function directoryEmptyCopy(
  itemCount: number,
  unavailableOnlyCount: number,
): { title: string; desc: string; action: string } | null {
  if (itemCount > 0 || unavailableOnlyCount > 0) return null;
  return { title: DIRECTORY_COPY.emptyTitle, desc: DIRECTORY_COPY.emptyDesc, action: DIRECTORY_COPY.emptyAction };
}

