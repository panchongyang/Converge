/**
 * 把《认知树.md》的「形成记录」表译成导入历史。
 *
 * 职责：按原行序保留行号、日期精度、叙述与原出处；同一行既有形成又有确认时拆成两条，
 * 共用原出处；节点关联从「形状变化」列实际提到的 ID 推出。
 * 边界：不补午夜或导入时刻，不给导入事实补造结构化明细；没有节点 ID 的补充句只并入
 * 上一条叙述，不凭空归到某个节点；第一个分句就无法识别时直接报错。
 * 协作：manuscript 传入已解析的概览顺序；内核为每条历史分配修订 ID。
 */
import type { SeedHistoryEntry } from '@cognition-tree/kernel/types';
import { ManuscriptError, splitTopLevel, uniqueHeadingLine } from './source';
import type { OverviewNode } from './tree';

/** 形成记录表的一行。 */
interface HistoryRow {
  /** 原表行号；同时写进 source。 */
  number: number;
  date: string;
  event: string;
  shape: string;
  /** 表格行号，1 起算。 */
  line: number;
}

/** 一条原行按形状变化拆出的导入记录。 */
interface EntryDraft {
  kind: 'formation' | 'confirmation';
  nodeIds: string[];
  /** 该条记录对应的形状变化原文；续句也并进这里。 */
  shape: string;
}

/** 形状变化里表示树结构变化的词；没有这些词的后续分句只当补充说明。 */
const SHAPE_VERB = /(长出|剪除|提出|建立|确认|复活|重新启用|替代)/;

/** 手稿原历史共 8 行；行数变化意味着原历史被改写，需要人重新核对映射。 */
const HISTORY_ROW_COUNT = 8;

/**
 * 读形成记录表并译成导入历史。
 * @param lines 手稿按行拆分后的全文
 * @param overview 概览顺序，用于展开节点范围并保持关联顺序
 * @returns 按原行序、行号与原时间精度排列的导入记录
 * @throws ManuscriptError 表头、日期、行号或形状变化无法可靠对应时
 */
export function buildHistory(lines: readonly string[], overview: readonly OverviewNode[]): SeedHistoryEntry[] {
  const rows = parseHistoryRows(lines);
  const order = overview.map((entry) => entry.id);
  const parentOf = new Map(overview.map((entry) => [entry.id, entry.parentId]));
  const rootId = overview[0]?.id;
  if (rootId === undefined) throw new ManuscriptError(1, '树概览没有根节点，无法归属建立手稿的记录');
  const history: SeedHistoryEntry[] = [];
  for (const row of rows) {
    for (const draft of splitHistoryRow(row, order, parentOf, rootId)) {
      history.push({
        kind: draft.kind,
        at: row.date,
        by: 'import',
        nodeIds: draft.nodeIds,
        summary: `${row.event} —— ${draft.shape}`,
        source: `认知树.md 形成记录 #${row.number}`,
      });
    }
  }
  return history;
}

/**
 * 把一行的「形状变化」按顶层分号拆开，形成确认分开、同类的相邻形成合并。
 * @param row 原表一行
 * @param order 概览里的节点顺序
 * @param parentOf 节点到父节点的映射
 * @param rootId 树根 ID，建立手稿的记录归到这里
 * @returns 该行对应的导入记录草稿，按原分句顺序
 */
function splitHistoryRow(
  row: HistoryRow,
  order: readonly string[],
  parentOf: ReadonlyMap<string, string | null>,
  rootId: string,
): EntryDraft[] {
  const segments = splitTopLevel(row.shape, '；', row.line).map((segment) => segment.trim());
  if (segments.some((segment) => segment === '')) throw new ManuscriptError(row.line, `形成记录第 ${row.number} 行的形状变化有空段`);
  const drafts: EntryDraft[] = [];
  for (const segment of segments) {
    const clean = stripParentheticals(segment);
    if (!SHAPE_VERB.test(clean)) {
      if (drafts.length === 0) {
        throw new ManuscriptError(row.line, `形成记录第 ${row.number} 行的分句「${segment}」不是可识别的形状变化`);
      }
      appendShape(drafts[drafts.length - 1], segment);
      continue;
    }
    const mentioned = mentionedNodeIds(segment, order, parentOf, row.line);
    if (mentioned.length === 0) {
      if (!clean.startsWith('建立') || drafts.length > 0) {
        throw new ManuscriptError(row.line, `形成记录第 ${row.number} 行的形状变化「${segment}」没有节点 ID`);
      }
      drafts.push({ kind: 'formation', nodeIds: [rootId], shape: segment });
      continue;
    }
    const kind = clean.endsWith('确认') ? 'confirmation' : 'formation';
    const last = drafts[drafts.length - 1];
    if (last !== undefined && last.kind === kind) {
      for (const id of mentioned) {
        if (!last.nodeIds.includes(id)) last.nodeIds.push(id);
      }
      appendShape(last, segment);
    } else {
      drafts.push({ kind, nodeIds: [...mentioned], shape: segment });
    }
  }
  if (drafts.length === 0) throw new ManuscriptError(row.line, `形成记录第 ${row.number} 行没有可导入的内容`);
  return drafts;
}

/**
 * 把后续分句接回上一条记录的形状变化原文。
 * @param draft 上一条记录
 * @param segment 当前分句
 */
function appendShape(draft: EntryDraft, segment: string): void {
  draft.shape += `；${segment}`;
}

/**
 * 去掉括注，避免把「（未确认）」误读成确认记录。
 * @param text 一个形状变化分句
 * @returns 不含括注的文本
 */
function stripParentheticals(text: string): string {
  return text.replace(/（[^（）]*）/g, '').trim();
}

/**
 * 读「形成记录」表格，严格核对表头、分隔行、行号顺序与日期精度。
 * @param lines 手稿按行拆分后的全文
 * @returns 按原表顺序排列的数据行
 */
function parseHistoryRows(lines: readonly string[]): HistoryRow[] {
  const heading = uniqueHeadingLine(lines, '## 形成记录');
  let start = -1;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('|')) {
      start = index;
      break;
    }
    if (trimmed !== '') throw new ManuscriptError(index + 1, '「形成记录」表格前出现无法映射的内容');
  }
  if (start === -1) throw new ManuscriptError(heading + 1, '「形成记录」缺少表格');

  const table: Array<{ cells: string[]; line: number }> = [];
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === '') {
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next].trim() !== '') throw new ManuscriptError(next + 1, '「形成记录」表格后出现无法映射的内容');
      }
      break;
    }
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
      throw new ManuscriptError(index + 1, '形成记录的表格行必须以 | 开头和结尾');
    }
    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length !== 4) throw new ManuscriptError(index + 1, `形成记录应为 4 列，实际 ${cells.length} 列`);
    table.push({ cells, line: index + 1 });
  }
  const header = table[0];
  if (header === undefined || header.cells.join('|') !== '#|日期|事件|形状变化') {
    throw new ManuscriptError(header?.line ?? heading + 1, '形成记录表头必须是「# | 日期 | 事件 | 形状变化」');
  }
  const separator = table[1];
  if (separator === undefined || !separator.cells.every((cell) => /^:?-+:?$/.test(cell))) {
    throw new ManuscriptError(separator?.line ?? heading + 1, '形成记录缺少表头分隔行');
  }

  const rows: HistoryRow[] = [];
  for (const { cells, line } of table.slice(2)) {
    const [rawRow, date, event, shape] = cells;
    if (!/^\d+$/.test(rawRow)) throw new ManuscriptError(line, `形成记录行号「${rawRow}」不是整数`);
    const number = Number(rawRow);
    if (number !== rows.length + 1) throw new ManuscriptError(line, `形成记录行号应为 ${rows.length + 1}，实际 ${number}`);
    if (!isKnownDate(date)) throw new ManuscriptError(line, `日期「${date}」无法保留可知精度`);
    if (event === '' || shape === '') throw new ManuscriptError(line, `形成记录第 ${number} 行的事件或形状变化为空`);
    rows.push({ number, date, event, shape, line });
  }
  if (rows.length === 0) throw new ManuscriptError(heading + 1, '「形成记录」里没有数据行');
  if (rows.length !== HISTORY_ROW_COUNT) {
    throw new ManuscriptError(heading + 1, `形成记录应有 ${HISTORY_ROW_COUNT} 行，实际 ${rows.length} 行；行数变化需人工复核`);
  }
  return rows;
}

/**
 * 判断日期是否是可按原精度保存的日期或带时区时刻。
 * @param value 手稿日期单元格
 * @returns 只有日期或带时区偏移的 ISO 时刻为真；不补午夜
 */
function isKnownDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

/**
 * 从形状变化文字里收集实际提到的节点，展开「A–B」和「及其子节点」。
 * @param shape 形成记录的形状变化原文
 * @param order 树概览的节点顺序
 * @param parentOf 节点到父节点的映射
 * @param line 表格行号，1 起算
 * @returns 按概览顺序排列的节点 ID
 */
function mentionedNodeIds(
  shape: string,
  order: readonly string[],
  parentOf: ReadonlyMap<string, string | null>,
  line: number,
): string[] {
  const mentioned = new Set<string>();
  for (const token of shape.match(/T1(?:\.\d+)*/g) ?? []) {
    if (!order.includes(token)) throw new ManuscriptError(line, `形状变化提到的节点 ${token} 不在树概览里`);
    mentioned.add(token);
  }
  for (const match of shape.matchAll(/(T1(?:\.\d+)*)[–-](T1(?:\.\d+)*)/g)) {
    const start = order.indexOf(match[1]);
    const end = order.indexOf(match[2]);
    if (start < 0 || end < start) {
      throw new ManuscriptError(line, `形状变化里的范围「${match[0]}」无法按树概览展开`);
    }
    for (const id of order.slice(start, end + 1)) mentioned.add(id);
  }
  if (shape.includes('及其子节点')) {
    for (const base of [...mentioned]) {
      for (const id of order) {
        if (isDescendant(id, base, parentOf)) mentioned.add(id);
      }
    }
  }
  return order.filter((id) => mentioned.has(id));
}

/**
 * 判断一个节点是否位于另一个节点的后代链上。
 * @param id 待判断节点
 * @param ancestor 可能的祖先
 * @param parentOf 节点到父节点的映射
 * @returns id 的父链经过 ancestor 时为真
 */
function isDescendant(id: string, ancestor: string, parentOf: ReadonlyMap<string, string | null>): boolean {
  let current = parentOf.get(id) ?? null;
  while (current !== null) {
    if (current === ancestor) return true;
    current = parentOf.get(current) ?? null;
  }
  return false;
}
