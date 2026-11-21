/**
 * 把《认知树.md》的「树概览」与「节点」小节译成种子节点。
 *
 * 职责：按缩进还原真实父子关系，按「### ID 标题」章节读取白名单字段，核对概览与
 * 章节的标题、状态和确认来源一致，并保留手稿缺项。
 * 边界：不读引用行与形成记录；不猜手稿没写的分支状态或确认程度。
 * 协作：manuscript 用 parseTree 取节点与章节，refs 复用章节里的「引用」原文。
 */
import type { BranchState, Confirmation, SeedNode } from '@cognition-tree/kernel/types';
import { ManuscriptError, uniqueHeadingLine } from './source';

/** 概览里的一行节点；父子关系由缩进确定。 */
export interface OverviewNode {
  id: string;
  parentId: string | null;
  title: string;
  /** 概览方括号里的状态；根和 T1.3 没有方括号。 */
  status?: ParsedStatus;
  /** 概览行号，1 起算。 */
  line: number;
}

/** 手稿状态行拆出的三个事实：分支状态、确认程度与括注。 */
export interface ParsedStatus {
  state?: BranchState;
  confirmation?: Confirmation;
  note?: string;
}

/** 一个「###」节点章节里按字段收集的原文。 */
export interface NodeSection {
  id: string;
  title: string;
  /** 标题行号，1 起算。 */
  line: number;
  fields: Map<string, { value: string; line: number }>;
}

/** 概览、章节与种子节点；一份手稿只解析一次。 */
export interface ParsedTree {
  overview: OverviewNode[];
  sections: Map<string, NodeSection>;
  nodes: SeedNode[];
}

/** 节点章节允许出现的字段；多一个就报错，避免把未翻译的原文静默留下。 */
const NODE_FIELDS = new Set(['状态', '来源', '依据', '内容', '剪除理由', '复活条件', '未决原因', '引用']);

/** 状态行：分支状态、确认来源与括注。确认来源允许「AI 提出」中有空格。 */
const STATUS_PATTERN = /^(留|剪|未决|已有结论)(?:\s*·\s*(人确认|人决定|AI\s*提出))?(?:（(.*)）)?$/;

/** 树概览的缩进前缀：每层三格，子节点以 ├─ 或 └─ 结尾。 */
const OVERVIEW_PATTERN = /^((?:│  |   )*(?:├─ |└─ )?)(T1(?:\.\d+)*)\s+(?:\[([^\]]+)\]\s+)?(.+)$/;

/**
 * 解析整棵树稿，并核对概览与节点章节一一对应。
 * @param lines 手稿按行拆分后的全文
 * @returns 概览顺序、章节索引与按原 ID 构造的种子节点
 * @throws ManuscriptError 缺少小节、标题/状态不一致或节点无法对应时
 */
export function parseTree(lines: readonly string[]): ParsedTree {
  const overview = parseOverview(lines);
  const sections = parseNodeSections(lines);
  const nodes: SeedNode[] = [];
  for (const entry of overview) {
    const section = sections.get(entry.id);
    if (section === undefined) throw new ManuscriptError(entry.line, `树概览里的 ${entry.id} 在「节点」小节没有对应章节`);
    nodes.push(buildNode(entry, section));
  }
  for (const section of sections.values()) {
    if (!overview.some((entry) => entry.id === section.id)) {
      throw new ManuscriptError(section.line, `「节点」小节的 ${section.id} 不在树概览里`);
    }
  }
  if (overview[0]?.id !== 'T1') throw new ManuscriptError(overview[0]?.line ?? 1, '这棵一次性种子的根必须是 T1');
  return { overview, sections, nodes };
}

/**
 * 读树概览的围栏代码块，按缩进还原父子关系。
 * @param lines 手稿按行拆分后的全文
 * @returns 概览顺序的节点行；父节点一定先于子节点出现
 */
function parseOverview(lines: readonly string[]): OverviewNode[] {
  const heading = uniqueHeadingLine(lines, '## 树概览');
  let start = -1;
  let end = -1;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('```')) {
      if (start === -1) start = index + 1;
      else {
        end = index;
        break;
      }
      continue;
    }
    if (start === -1 && trimmed.startsWith('## ')) break;
  }
  if (start === -1 || end === -1) throw new ManuscriptError(heading + 1, '「树概览」缺少围栏代码块');

  const nodes: OverviewNode[] = [];
  const stack: OverviewNode[] = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = OVERVIEW_PATTERN.exec(line);
    if (match === null) throw new ManuscriptError(index + 1, `无法识别的树概览行「${trimmed}」`);
    const [, prefix, id, bracket, rawTitle] = match;
    if (prefix.length % 3 !== 0) throw new ManuscriptError(index + 1, `树概览缩进不是三格的整数倍「${prefix}」`);
    const depth = prefix.length / 3;
    if (depth > 0 && !/(?:├─ |└─ )$/.test(prefix)) {
      throw new ManuscriptError(index + 1, `树概览节点 ${id} 缺少分支符号「${prefix}」`);
    }
    let parentId: string | null = null;
    if (depth === 0) {
      if (nodes.length > 0) throw new ManuscriptError(index + 1, '树概览只能有一个根节点');
    } else {
      const parent = stack[depth - 1];
      if (parent === undefined) throw new ManuscriptError(index + 1, `节点 ${id} 缺少第 ${depth} 层的父节点`);
      if (!id.startsWith(`${parent.id}.`) || !/^\d+$/.test(id.slice(parent.id.length + 1))) {
        throw new ManuscriptError(index + 1, `节点 ${id} 的 ID 与父节点 ${parent.id} 的层级不一致`);
      }
      parentId = parent.id;
    }
    const status = bracket === undefined ? undefined : parseStatus(bracket, index + 1);
    const node: OverviewNode = { id, parentId, title: rawTitle.trim(), status, line: index + 1 };
    if (nodes.some((existing) => existing.id === id)) throw new ManuscriptError(index + 1, `树概览里的节点 ${id} 重复`);
    stack.length = depth;
    stack.push(node);
    nodes.push(node);
  }
  if (nodes.length === 0) throw new ManuscriptError(heading + 1, '「树概览」里没有节点');
  return nodes;
}

/**
 * 读「节点」小节里的「### ID 标题」章节，按白名单字段收集原文。
 * @param lines 手稿按行拆分后的全文
 * @returns 以稳定节点 ID 为键的章节；重复 ID 直接报错
 */
function parseNodeSections(lines: readonly string[]): Map<string, NodeSection> {
  const heading = uniqueHeadingLine(lines, '## 节点');
  let end = lines.length;
  for (let index = heading + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('## ')) {
      end = index;
      break;
    }
  }
  const sections = new Map<string, NodeSection>();
  let current: NodeSection | undefined;
  for (let index = heading + 1; index < end; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === '') continue;
    const match = /^### (T1(?:\.\d+)*)\s+(.+)$/.exec(trimmed);
    if (match !== null) {
      const [, id, title] = match;
      if (sections.has(id)) throw new ManuscriptError(index + 1, `节点 ${id} 的章节重复`);
      current = { id, title: title.trim(), line: index + 1, fields: new Map() };
      sections.set(id, current);
      continue;
    }
    if (trimmed.startsWith('### ')) throw new ManuscriptError(index + 1, `无法识别的节点标题「${trimmed}」`);
    if (current === undefined) throw new ManuscriptError(index + 1, '「节点」小节里出现不属于任何节点的内容');
    const bullet = /^- ([^：]+)：(.*)$/.exec(trimmed);
    if (bullet === null) throw new ManuscriptError(index + 1, `节点 ${current.id} 只允许「- 字段：值」行`);
    const name = bullet[1].trim();
    const value = bullet[2].trim();
    if (!NODE_FIELDS.has(name)) throw new ManuscriptError(index + 1, `节点 ${current.id} 出现未知字段「${name}」`);
    if (value === '') throw new ManuscriptError(index + 1, `节点 ${current.id} 的「${name}」为空`);
    if (current.fields.has(name)) throw new ManuscriptError(index + 1, `节点 ${current.id} 的「${name}」重复`);
    current.fields.set(name, { value, line: index + 1 });
  }
  if (sections.size === 0) throw new ManuscriptError(heading + 1, '「节点」小节里没有节点章节');
  return sections;
}

/**
 * 用概览的父子关系和节点章节的字段构造一条种子节点。
 * @param overview 概览里的一行
 * @param section 对应的节点章节
 * @returns 保留手稿原 ID、正文与缺项的种子节点
 */
function buildNode(overview: OverviewNode, section: NodeSection): SeedNode {
  if (section.title !== overview.title && !isOverviewAnnotation(section.title, overview.title)) {
    throw new ManuscriptError(section.line, `节点 ${section.id} 的标题「${section.title}」与树概览「${overview.title}」不一致`);
  }
  const statusField = section.fields.get('状态');
  const status: ParsedStatus = statusField === undefined ? {} : parseStatus(statusField.value, statusField.line);
  if (overview.status !== undefined) {
    if (statusField === undefined) throw new ManuscriptError(section.line, `节点 ${section.id} 在概览标了状态，章节却缺少「状态」`);
    if (status.state !== overview.status.state || status.confirmation !== overview.status.confirmation) {
      throw new ManuscriptError(statusField.line, `节点 ${section.id} 的章节状态与树概览不一致`);
    }
  }

  const body: SeedNode['body'] = { title: section.title };
  const text = readField(section, '内容');
  const basis = readField(section, '依据');
  const source = readField(section, '来源');
  const openReason = readField(section, '未决原因');
  if (text !== undefined) body.text = text;
  if (basis !== undefined) body.basis = basis;
  if (source !== undefined) body.source = source;
  if (openReason !== undefined) body.openReason = openReason;
  if (status.note !== undefined) body.note = status.note;

  const pruneReason = readField(section, '剪除理由');
  const reviveWhen = readField(section, '复活条件');
  if ((pruneReason !== undefined || reviveWhen !== undefined) && status.state !== 'prune') {
    throw new ManuscriptError(section.line, `节点 ${section.id} 不是剪除状态，却记录了剪除理由或复活条件`);
  }
  if (openReason !== undefined && status.state !== 'open') {
    throw new ManuscriptError(section.line, `节点 ${section.id} 不是未决状态，却记录了未决原因`);
  }

  const node: SeedNode = { id: section.id, parentId: overview.parentId, body, origin: { kind: 'branch' } };
  if (status.state !== undefined) node.state = status.state;
  if (status.confirmation !== undefined) node.confirmation = status.confirmation;
  if (pruneReason !== undefined) node.pruneReason = pruneReason;
  if (reviveWhen !== undefined) node.reviveWhen = reviveWhen;
  return node;
}

/**
 * 把状态行译成分支状态、确认程度与括注。
 *
 * 「已有结论」不猜分支状态；缺确认来源时保持缺失。「未确认」已由 confirmation 表达，
 * 不再重复写成括注；「人决定」没有对应的确认程度取值，保留在括注里以免丢原文。
 * @param text 去掉「- 状态：」后的原文
 * @param line 原文行号，1 起算
 * @returns 三个字段都只写手稿明确载明的部分
 */
function parseStatus(text: string, line: number): ParsedStatus {
  const match = STATUS_PATTERN.exec(text.trim());
  if (match === null) throw new ManuscriptError(line, `无法识别的状态「${text}」`);
  const [, label, source, parenthetical] = match;
  const state = label === '留' ? 'keep' : label === '剪' ? 'prune' : label === '未决' ? 'open' : undefined;
  const token = source?.replace(/\s+/g, '');
  const confirmation = token === undefined ? undefined : token === 'AI提出' ? 'unconfirmed' : 'humanConfirmed';
  const note = parenthetical?.trim();
  const result: ParsedStatus = {};
  if (state !== undefined) result.state = state;
  if (confirmation !== undefined) result.confirmation = confirmation;
  if (label === '已有结论') {
    // 这一写法没有对应的分支状态；整句保留在括注里，免得只剩「见 T1.3.3」。
    result.note = text.trim();
  } else if (note === '未确认' && confirmation === 'unconfirmed') {
    // 与 confirmation 完全重复，不把同一事实写成两处。
  } else if (note !== undefined && note !== '') {
    result.note = note;
  } else if (token === '人决定') {
    result.note = '人决定';
  }
  return result;
}

/**
 * 取节点章节里的一个字段原文。
 * @param section 节点章节
 * @param name 白名单里的字段名
 * @returns 字段原文；未载时保持 undefined
 */
function readField(section: NodeSection, name: string): string | undefined {
  return section.fields.get(name)?.value;
}

/**
 * 允许树概览标题比章节标题多一个括注，例如「（复活条件）」。
 *
 * 章节标题是正文标题的唯一来源；概览括注只是树上的显示提示，没有对应正文字段，
 * 因此校验形状后不写入种子，也不据此改标题。
 * @param heading 节点章节标题
 * @param overview 树概览标题
 * @returns 概览标题等于章节标题加一个非空括注时为真
 */
function isOverviewAnnotation(heading: string, overview: string): boolean {
  if (!overview.startsWith(heading)) return false;
  const rest = overview.slice(heading.length);
  return /^（[^（）]+）$/.test(rest);
}
