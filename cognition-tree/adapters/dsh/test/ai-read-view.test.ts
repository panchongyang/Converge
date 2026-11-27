/**
 * 紧凑 AI 读取视图的往返、边界压缩与严格噪声测试。
 *
 * 测试独立实现 CTV2 解码器，不复用生产实现的桶表或字段拼装；导出 `decodeAiReadView`
 * 供端到端测试复用。100 节点原型包含真实 leaf 读会带的 100 条 children exhausted，
 * 并按“命中标题 + state 原词 + confirmation 原词”计算严格噪声。
 */
import { describe, expect, it } from 'vitest';
import type { Boundary, Ref, TreeView, ViewNode } from '@cognition-tree/kernel/types';
import { AI_READ_VIEW_GUIDE, canCompactAiReadView, compactAiReadView } from '../src/server/ai-read-view';

/** 构造轻行；未给的可选字段保持省略，测试“未载”与显式值的区别。 */
function viewNode(partial: Partial<ViewNode> & Pick<ViewNode, 'id' | 'title'>): ViewNode {
  return {
    id: partial.id,
    parentId: partial.parentId ?? null,
    title: partial.title,
    origin: partial.origin ?? { kind: 'branch' },
    role: partial.role ?? 'hit',
    ...(partial.state === undefined ? {} : { state: partial.state }),
    ...(partial.confirmation === undefined ? {} : { confirmation: partial.confirmation }),
    ...(partial.currentChange === undefined ? {} : { currentChange: partial.currentChange }),
  };
}

/** 取 JSON 字符串的结束位置；调用方保证 start 处是双引号。 */
function scanQuoted(line: string, start: number): number {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === '\\') { index += 2; continue; }
    if (line[index] === '"') return index + 1;
    index++;
  }
  throw new Error(`未闭合的 JSON 字符串: ${line.slice(start)}`);
}

/** 读取一个以 delimiter 结束的字段；JSON 字符串内部的 delimiter 不截断。 */
function readDelimited(line: string, start: number, delimiter: string): { raw: string; end: number } {
  if (line[start] === '"') {
    const end = scanQuoted(line, start);
    return { raw: line.slice(start, end), end };
  }
  const at = line.indexOf(delimiter, start);
  return { raw: line.slice(start, at < 0 ? line.length : at), end: at < 0 ? line.length : at };
}

/** 解析 key=value 字段；字符串值可以含空格，不会被空白切断。 */
function readFields(line: string, start: number): { values: Map<string, string>; raw: Map<string, string>; end: number } {
  const values = new Map<string, string>();
  const raw = new Map<string, string>();
  let index = start;
  while (index < line.length) {
    while (line[index] === ' ') index++;
    if (index >= line.length) break;
    const keyStart = index;
    while (index < line.length && line[index] !== '=' && line[index] !== ' ') index++;
    if (line[index] !== '=') break;
    const key = line.slice(keyStart, index);
    index++;
    if (line[index] === '"') {
      const end = scanQuoted(line, index);
      const token = line.slice(index, end);
      raw.set(key, token);
      values.set(key, JSON.parse(token) as string);
      index = end;
    } else {
      let end = index;
      while (end < line.length && line[end] !== ' ') end++;
      const token = line.slice(index, end);
      raw.set(key, token);
      values.set(key, token);
      index = end;
    }
  }
  return { values, raw, end: index };
}

/** 把短写拼回真实 ID；只使用页内桶表和固定拼接规则。 */
function decodeId(raw: string, table: readonly string[], prefixLength: number, family: 'n' | 'r'): string {
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  const pattern = family === 'n'
    ? /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([A-Za-z0-9._-]+))?$/
    : /^r(\d+)\.(\d+)(?:\.(\d+))?(?:-([A-Za-z0-9._-]+))?$/;
  const match = pattern.exec(raw);
  if (match === null) throw new Error(`无法解码 ${family} ID: ${raw}`);
  const prefix = table[Number(match[1]) - 1];
  if (prefix === undefined) throw new Error(`桶号越界: ${raw}`);
  const suffix = match[2]!;
  if (suffix.length !== 13 - prefixLength) throw new Error(`后缀长度不符: ${raw}`);
  const milliseconds = prefix + suffix;
  const ordinal = match[3] === undefined ? '0000000000000001' : match[3].padStart(16, '0');
  if (ordinal.length !== 16) throw new Error(`序号超出 16 位: ${raw}`);
  const collision = match[4] === undefined ? '' : `-${match[4]}`;
  return `${family === 'n' ? 'node-rev-' : 'rev-'}${milliseconds}-${ordinal}${collision}`;
}

/** 节点行 ID：沿用最近一个 # 前缀，行内只写 13-N 位后缀。 */
function decodeNodeId(raw: string, prefixLength: number, currentPrefix: string | undefined): string {
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (currentPrefix === undefined) throw new Error(`节点行前缺少 # 前缀: ${raw}`);
  const match = /^(\d+)(?:\.(\d+))?(?:-([A-Za-z0-9._-]+))?$/.exec(raw);
  if (match === null) throw new Error(`无法解码节点 ID: ${raw}`);
  const suffix = match[1]!;
  if (suffix.length !== 13 - prefixLength) throw new Error(`节点后缀长度不符: ${raw}`);
  const milliseconds = currentPrefix + suffix;
  const ordinal = match[2] === undefined ? '0000000000000001' : match[2].padStart(16, '0');
  if (ordinal.length !== 16) throw new Error(`节点序号超出 16 位: ${raw}`);
  const collision = match[3] === undefined ? '' : `-${match[3]}`;
  return `node-rev-${milliseconds}-${ordinal}${collision}`;
}

/** 标题反转义；与生产端 escapeTitle 的转义表一一对应。 */
function unescapeTitle(raw: string): string {
  const backslash = String.fromCharCode(92);
  let output = '';
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!;
    if (character !== backslash) { output += character; continue; }
    const next = raw[++index];
    if (next === undefined) throw new Error('标题以孤立反斜杠结束');
    if (next === backslash) output += backslash;
    else if (next === '|') output += '|';
    else if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 'x' || next === 'u') {
      const length = next === 'x' ? 2 : 4;
      const hex = raw.slice(index + 1, index + 1 + length);
      if (hex.length !== length || !/^[0-9a-f]+$/i.test(hex)) throw new Error(`坏的控制字符转义: ${hex}`);
      output += String.fromCharCode(parseInt(hex, 16));
      index += length;
    } else throw new Error(`未知标题转义: \\${next}`);
  }
  return output;
}

/** 按逗号切分边界项，JSON 字符串内部的逗号不切。 */
function splitItems(text: string): string[] {
  const items: string[] = [];
  let start = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      if (character === '\\') index++;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === ',') { items.push(text.slice(start, index)); start = index + 1; }
  }
  items.push(text.slice(start));
  return items.filter((item) => item.length > 0);
}

/** 展开页内序号的逗号列表与连续段。 */
function expandIndices(text: string): number[] {
  const indices: number[] = [];
  for (const item of splitItems(text)) {
    const range = /^(\d+)-(\d+)$/.exec(item);
    if (range === null) { indices.push(Number(item)); continue; }
    for (let index = Number(range[1]); index <= Number(range[2]); index++) indices.push(index);
  }
  return indices;
}

/** 独立解码结果。 */
export interface DecodedAiReadView {
  view: TreeView;
  prefixLength: number;
}

/**
 * 解码一页 CTV2 文本，供测试和主控端到端复用。
 * 返回完整 TreeView 和本页前缀长度；任何字段缺失、桶号越界或转义错误都直接抛出。
 * @param text compactAiReadView 的输出
 */
export function decodeAiReadView(text: string): DecodedAiReadView {
  const lines = text.split('\n');
  const headerToken = readDelimited(lines[0]!, 0, ' ');
  if (headerToken.raw !== 'CTV2') throw new Error(`不是 CTV2 页: ${headerToken.raw}`);
  const header = readFields(lines[0]!, headerToken.end);
  const prefixLength = Number(header.values.get('p'));
  const table: string[] = [];
  let currentPrefix: string | undefined;
  const nodes: ViewNode[] = [];
  const order: string[] = [];
  const path: string[] = [];
  const refs: Ref[] = [];
  const boundaries: Boundary[] = [];
  const groups = new Map<string, Set<number>>();
  const nodeNotes = new Map<number, string[]>();
  const stateOf = (textValue: string): ViewNode['state'] => {
    if (textValue === '') return undefined;
    if (textValue === 'keep' || textValue === 'prune' || textValue === 'open') return textValue;
    throw new Error(`未知 state: ${textValue}`);
  };
  const confirmOf = (textValue: string): ViewNode['confirmation'] => {
    if (textValue === '') return undefined;
    if (textValue === 'unconfirmed' || textValue === 'humanConfirmed') return textValue;
    throw new Error(`未知 confirmation: ${textValue}`);
  };

  for (const line of lines.slice(1)) {
    if (line.startsWith('#')) {
      currentPrefix = line.slice(1);
      if (!table.includes(currentPrefix)) table.push(currentPrefix);
      continue;
    }
    if (line.startsWith('@')) {
      const group = /^@([a-z:-]+)=(.+)$/.exec(line);
      if (group !== null) {
        const code = group[1]!;
        const indices = groups.get(code) ?? new Set<number>();
        for (const index of expandIndices(group[2]!)) indices.add(index);
        groups.set(code, indices);
        continue;
      }
      const single = /^@(\d+)(.*)$/.exec(line);
      if (single === null) throw new Error(`坏的旁注: ${line}`);
      nodeNotes.set(Number(single[1]), single[2] === '' ? [] : splitItems(single[2]));
      continue;
    }
    if (line.startsWith('~')) {
      const match = /^~([cr][seb])=(.*)$/.exec(line);
      if (match === null) throw new Error(`坏的边界行: ${line}`);
      const code = match[1]!;
      const axis: Boundary['axis'] = code[0] === 'c' ? 'children' : 'refs';
      const kind: Boundary['kind'] = code[1] === 's' ? 'scope' : code[1] === 'e' ? 'exhausted' : 'budget';
      for (const item of splitItems(match[2]!)) {
        if (item.startsWith('id:')) {
          boundaries.push({ nodeId: decodeId(item.slice(3), table, prefixLength, 'n'), axis, kind });
          continue;
        }
        const range = /^(\d+)-(\d+)$/.exec(item);
        const start = range === null ? Number(item) : Number(range[1]);
        const end = range === null ? start : Number(range[2]);
        for (let index = start; index <= end; index++) {
          const nodeId = order[index - 1];
          if (nodeId === undefined) throw new Error(`边界序号越界: ${item}`);
          boundaries.push({ nodeId, axis, kind });
        }
      }
      continue;
    }
    if (line.startsWith('R ')) {
      const parsed = readFields(line, 1);
      const target = parsed.values.has('to')
        ? { nodeId: decodeId(parsed.raw.get('to')!, table, prefixLength, 'n') }
        : { doc: parsed.values.get('doc')! };
      refs.push({
        id: parsed.values.get('id')!,
        from: decodeId(parsed.raw.get('from')!, table, prefixLength, 'n'),
        kind: ({ p: 'premise', e: 'example', c: 'conflict' } as const)[parsed.values.get('kind') as 'p' | 'e' | 'c'],
        target: parsed.values.has('part') ? { ...target, part: parsed.values.get('part')! } : target,
      });
      continue;
    }
    if (line === '') continue;

    const indent = line.length - line.trimStart().length;
    let cursor = indent;
    let role: ViewNode['role'] = 'hit';
    if (line[cursor] === '-') { role = 'link'; cursor++; }
    const idField = readDelimited(line, cursor, '|');
    const stateEnd = line.indexOf('|', idField.end + 1);
    if (stateEnd < 0) throw new Error(`节点行缺少 state 分隔符: ${line}`);
    const state = line.slice(idField.end + 1, stateEnd);
    const confirmEnd = line.indexOf('|', stateEnd + 1);
    if (confirmEnd < 0) throw new Error(`节点行缺少 confirmation 分隔符: ${line}`);
    const confirmation = line.slice(stateEnd + 1, confirmEnd);
    const title = unescapeTitle(line.slice(confirmEnd + 1));
    const id = decodeNodeId(idField.raw, prefixLength, currentPrefix);
    const parentId = indent === 0 ? null : path[indent - 1]!;
    path[indent] = id;
    order.push(id);
    nodes.push(viewNode({ id, parentId, title, role, ...(stateOf(state) === undefined ? {} : { state: stateOf(state) }), ...(confirmOf(confirmation) === undefined ? {} : { confirmation: confirmOf(confirmation) }) }));
  }

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const pageIndex = index + 1;
    const tokens = nodeNotes.get(pageIndex) ?? [];
    if (groups.get('o:s')?.has(pageIndex) === true) node.origin = { kind: 'supplement' };
    else if (groups.get('o:e')?.has(pageIndex) === true) node.origin = { kind: 'erratum' };
    else if (tokens.includes('o=r')) {
      const ot = tokens.find(token => token.startsWith('ot='));
      if (ot === undefined) throw new Error(`替代候选缺少 ot: @${pageIndex}`);
      const os = tokens.find(token => token.startsWith('os='));
      node.origin = {
        kind: 'replacement',
        replacesId: decodeId(ot.slice(3), table, prefixLength, 'n'),
        status: os === 'os=a' ? 'applied' : 'proposed',
      };
    }
    const revisionToken = tokens.find(token => token.startsWith('r') || token.startsWith('"'));
    const human = groups.get('h')?.has(pageIndex) === true || tokens.includes('h');
    if (groups.get('-')?.has(pageIndex) === true) {
      // 显式“没有 currentChange”，不能由节点 ID 反推。
    } else if (revisionToken !== undefined) {
      node.currentChange = { revisionId: decodeId(revisionToken, table, prefixLength, 'r'), by: human ? 'human' : 'ai' };
    } else if (node.id.startsWith('node-')) {
      node.currentChange = { revisionId: node.id.slice('node-'.length), by: human ? 'human' : 'ai' };
    } else {
      throw new Error(`节点 ${node.id} 缺少 currentChange 旁注`);
    }
    const parentToken = tokens.find(token => token.startsWith('p='));
    if (parentToken !== undefined) node.parentId = decodeId(parentToken.slice(2), table, prefixLength, 'n');
  }

  return {
    view: {
      rootId: decodeId(header.raw.get('root')!, table, prefixLength, 'n'),
      focusId: decodeId(header.raw.get('focus')!, table, prefixLength, 'n'),
      nodes,
      refs,
      boundaries,
      complete: header.values.get('c') === '1',
      stamp: Number(header.values.get('t')),
      ...(header.values.has('cursor') ? { cursor: header.values.get('cursor') } : {}),
    },
    prefixLength,
  };
}

/** 严格噪声：紧凑总字节中，扣掉实际写出的命中标题、state 原词、confirmation 原词后的占比。 */
export interface StrictNoise {
  compactBytes: number;
  essentialBytes: number;
  noise: number;
  /** 25% 噪声允许的最大紧凑字节；不足时 shortfallBytes > 0。 */
  maxCompactForQuarter: number;
  shortfallBytes: number;
}

/**
 * 按主控定义计算严格噪声。
 * 命中 title、state 原词、confirmation 原词都按原字面 UTF-8 计为信号；不把缩写当信号。
 * @param text compactAiReadView 的输出
 * @param view 原始 TreeView
 */
export function aiReadViewStrictNoise(text: string, view: TreeView): StrictNoise {
  const compactBytes = Buffer.byteLength(text, 'utf8');
  let essentialBytes = 0;
  for (const node of view.nodes) {
    if (node.role === 'hit') essentialBytes += Buffer.byteLength(node.title, 'utf8');
    if (node.state !== undefined) essentialBytes += Buffer.byteLength(node.state, 'utf8');
    if (node.confirmation !== undefined) essentialBytes += Buffer.byteLength(node.confirmation, 'utf8');
  }
  const maxCompactForQuarter = essentialBytes / 0.75;
  return {
    compactBytes,
    essentialBytes,
    noise: (compactBytes - essentialBytes) / compactBytes,
    maxCompactForQuarter,
    shortfallBytes: Math.max(0, compactBytes - maxCompactForQuarter),
  };
}

/** 节点按 ID 排序后比较；兄弟顺序不影响结构等价。 */
function sortedView(view: TreeView): TreeView {
  return {
    ...view,
    nodes: [...view.nodes].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    refs: [...view.refs],
    boundaries: [...view.boundaries].sort((left, right) => {
      const leftKey = `${left.nodeId}\u0000${left.axis}\u0000${left.kind}`;
      const rightKey = `${right.nodeId}\u0000${right.axis}\u0000${right.kind}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
}

/** 100 节点真实风格 no-hop 原型：根 + 9 组 + 90 叶，100 条 children exhausted。 */
function prototype100(): TreeView {
  const base = 1735689600000;
  const day = 86_400_000;
  const titles = [
    '共同认知用什么结构表达？',
    '决策树：节点是判断，不是发言',
    '剪枝记录理由及成立条件',
    '过程只记录改变树形状的事件',
    '概念单独成层，由决策节点引用',
    '结构由 AI 提议维护，人确认或纠正',
    '树 + 有类型引用边',
    '边类型少而固定，新增须说明',
    '存储与展示分离',
    '用认知事件做纸面验证',
  ];
  const nodes: ViewNode[] = [];
  const id = (ms: number, ordinal = 1): string => `node-rev-${ms}-${String(ordinal).padStart(16, '0')}`;
  const revision = (ms: number, ordinal = 1): string => `rev-${ms}-${ordinal.toString().padStart(16, '0')}`;
  const title = (index: number): string => titles[index % titles.length]!;
  /** 真实生成节点：初始修订与节点同毫秒同序号；少数人执行/后续修订/无变更。 */
  const nodeOf = (index: number, ms: number, ordinal: number, parentId: string | null, role: ViewNode['role']): ViewNode => {
    const initial = revision(ms, ordinal);
    const human = index > 0 && index % 13 === 0;
    const later = index > 0 && index % 17 === 0;
    const missing = index > 0 && index % 19 === 0;
    const changed = later ? revision(ms + 5_000, ordinal) : initial;
    return viewNode({
      id: id(ms, ordinal),
      parentId,
      title: title(index),
      role,
      ...(index % 5 === 0 ? {} : { state: index % 3 === 0 ? 'open' as const : index % 3 === 1 ? 'keep' as const : 'prune' as const }),
      ...(index % 4 === 0 ? {} : { confirmation: index % 3 === 1 ? 'unconfirmed' as const : 'humanConfirmed' as const }),
      ...(missing ? {} : { currentChange: { revisionId: changed, by: human ? 'human' as const : 'ai' as const } }),
    });
  };

  nodes.push(nodeOf(0, base, 1, null, 'link'));
  let serial = 1;
  let lastLeafId = '';
  for (let group = 0; group < 9; group++) {
    const groupMs = base + (group + 1) * day;
    const groupId = id(groupMs);
    nodes.push(nodeOf(serial++, groupMs, 1, id(base), group === 8 ? 'link' : 'hit'));
    for (let leaf = 0; leaf < 10; leaf++) {
      const sameMillisecond = leaf > 0 && leaf % 7 === 0;
      const leafMs = groupMs + (sameMillisecond ? leaf : leaf + 1) * 17_500;
      const ordinal = sameMillisecond ? 2 : 1;
      const leafId = id(leafMs, ordinal);
      const role: ViewNode['role'] = group === 8 && leaf === 9 ? 'link' : 'hit';
      nodes.push(nodeOf(serial++, leafMs, ordinal, groupId, role));
      lastLeafId = leafId;
    }
  }
  return {
    rootId: id(base),
    focusId: lastLeafId,
    nodes,
    refs: [],
    boundaries: nodes.map((node) => ({ nodeId: node.id, axis: 'children', kind: 'exhausted' })),
    complete: true,
    stamp: 42,
  };
}

describe('AI 紧凑读取视图', () => {
  it('独立解析后逐字段还原：缩进父链、两轴边界、跨引用、尾页与稀疏旁注', () => {
    const weirdId = 'legacy "A" \\ 行\n二 空格';
    const view: TreeView = {
      rootId: 'node-rev-1735689600000-0000000000000001',
      focusId: 'node-rev-1735689775000-0000000000000004',
      nodes: [
        viewNode({ id: 'node-rev-1735689600000-0000000000000001', title: '根问题：如何把长 ID 拼回来？', role: 'link', state: 'keep', confirmation: 'humanConfirmed', currentChange: { revisionId: 'rev-1735689600000-0000000000000001', by: 'human' } }),
        viewNode({ id: weirdId, parentId: 'node-rev-1735689600000-0000000000000001', title: '特殊标题 | "引号" 与 emoji 🧠\ud800\u2028', role: 'hit', state: 'open', confirmation: 'unconfirmed', origin: { kind: 'supplement' }, currentChange: { revisionId: 'rev-1735689600000-0000000000000002', by: 'ai' } }),
        viewNode({ id: 'node-rev-1735689600000-0000000000000002-1', parentId: weirdId, title: '同毫秒碰撞后缀', role: 'link' }),
        viewNode({ id: 'node-rev-1735689775000-0000000000000004', parentId: weirdId, title: '替代候选：剪除理由', role: 'hit', state: 'prune', origin: { kind: 'replacement', replacesId: 'legacy "A" \\ 行\n二 空格', status: 'proposed' }, currentChange: { revisionId: 'rev-1735689775000-0000000000000001', by: 'ai' } }),
        viewNode({ id: 'node-rev-1735689600000-0000000000000003', parentId: 'node-rev-1735689600000-0000000000000001', title: '兄弟：仅连接', role: 'link', origin: { kind: 'erratum' } }),
        viewNode({ id: '含 空格 的旧 ID', parentId: 'node-rev-1735689600000-0000000000000003', title: '旧 ID 与文档引用', role: 'hit', confirmation: 'unconfirmed' }),
      ],
      refs: [
        { id: 'ref-1-含 空格-α', from: weirdId, kind: 'example', target: { nodeId: 'node-rev-1735689775000-0000000000000004', part: '剪除理由' } },
        { id: 'ref-2', from: 'node-rev-1735689775000-0000000000000004', kind: 'premise', target: { doc: 'docs/设计 文档.md', part: '§2 引用' } },
        { id: 'ref-3', from: 'node-rev-1735689600000-0000000000000003', kind: 'conflict', target: { nodeId: weirdId } },
        { id: 'ref-4', from: '含 空格 的旧 ID', kind: 'example', target: { doc: 'docs/other.md' } },
      ],
      boundaries: [
        { nodeId: 'node-rev-1735689600000-0000000000000003', axis: 'children', kind: 'exhausted' },
        { nodeId: weirdId, axis: 'refs', kind: 'budget' },
        { nodeId: 'node-rev-1735689775000-0000000000000004', axis: 'refs', kind: 'scope' },
      ],
      complete: false,
      stamp: 99,
      cursor: 'qgen.1/"尾页"',
    };

    const text = compactAiReadView(view);
    expect(text).toBeTypeOf('string');
    const decoded = decodeAiReadView(text!).view;
    expect(decoded.rootId).toBe(view.rootId);
    expect(decoded.focusId).toBe(view.focusId);
    expect(decoded.stamp).toBe(99);
    expect(decoded.complete).toBe(false);
    expect(decoded.cursor).toBe(view.cursor);
    expect([...decoded.nodes].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).toEqual(sortedView(view).nodes);
    expect(decoded.refs).toEqual(view.refs);
    expect([...decoded.boundaries].sort((left, right) => { const a = `${left.nodeId}\u0000${left.axis}\u0000${left.kind}`; const b = `${right.nodeId}\u0000${right.axis}\u0000${right.kind}`; return a < b ? -1 : a > b ? 1 : 0; })).toEqual(sortedView(view).boundaries);
    // 确认不按执行者推断：未载仍是未载。
    expect(decoded.nodes.find(node => node.id === 'node-rev-1735689600000-0000000000000003')?.confirmation).toBeUndefined();
  });

  it('每页独立：不同 stamp/cursor 的页各自带全量桶表，不共享上一页状态', () => {
    const first: TreeView = {
      rootId: 'node-rev-1700000000000-0000000000000001', focusId: 'node-rev-1700000000000-0000000000000001',
      nodes: [viewNode({ id: 'node-rev-1700000000000-0000000000000001', title: '第一页' }), viewNode({ id: 'node-rev-1700000000000-0000000000000002', parentId: 'node-rev-1700000000000-0000000000000001', title: '旧页尾' })],
      refs: [], boundaries: [], complete: false, stamp: 1, cursor: 'q1',
    };
    const second: TreeView = {
      rootId: 'node-rev-1800000000000-0000000000000001', focusId: 'node-rev-1800000000000-0000000000000001',
      nodes: [viewNode({ id: 'node-rev-1800000000000-0000000000000001', title: '第二页' }), viewNode({ id: 'node-rev-1800000000000-0000000000000002', parentId: 'node-rev-1800000000000-0000000000000001', title: '新页尾' })],
      refs: [], boundaries: [{ nodeId: 'node-rev-1800000000000-0000000000000001', axis: 'refs', kind: 'exhausted' }], complete: true, stamp: 2,
    };
    const firstText = compactAiReadView(first)!;
    const secondText = compactAiReadView(second)!;
    expect(firstText).toContain('#17000000');
    expect(secondText).toContain('#18000000');
    expect(decodeAiReadView(firstText).view.nodes).toEqual(sortedView(first).nodes);
    expect(decodeAiReadView(secondText).view.nodes).toEqual(sortedView(second).nodes);
    expect(decodeAiReadView(secondText).view.boundaries).toEqual(second.boundaries);
  });

  it('超过 128 节点或 256 引用立即返回 undefined，边界值仍可投影', () => {
    const base = (count: number): TreeView => ({
      rootId: 'node-rev-1700000000000-0000000000000001', focusId: 'node-rev-1700000000000-0000000000000001',
      nodes: Array.from({ length: count }, (_, index) => viewNode({
        id: index === 0 ? 'node-rev-1700000000000-0000000000000001' : `node-rev-${1700000000000 + index}-0000000000000001`,
        parentId: index === 0 ? null : 'node-rev-1700000000000-0000000000000001',
        title: `节点 ${index}`,
      })),
      refs: [], boundaries: [], complete: true, stamp: 3,
    });
    expect(canCompactAiReadView(0, 0)).toBe(true);
    expect(canCompactAiReadView(128, 256)).toBe(true);
    expect(canCompactAiReadView(129, 0)).toBe(false);
    expect(canCompactAiReadView(0, 257)).toBe(false);
    expect(compactAiReadView(base(128))).toBeTypeOf('string');
    expect(compactAiReadView(base(129))).toBeUndefined();
    const nodes = base(1).nodes;
    const refsOf = (count: number): Ref[] => Array.from({ length: count }, (_, index) => ({ id: `ref-${index}`, from: nodes[0]!.id, kind: 'premise', target: { nodeId: nodes[0]!.id } }));
    expect(compactAiReadView({ ...base(1), refs: refsOf(256) })).toBeTypeOf('string');
    expect(compactAiReadView({ ...base(1), refs: refsOf(257) })).toBeUndefined();
  });

  it('100 节点真实 leaf 读：100 条 children exhausted 仍可往返，并报告严格噪声', () => {
    const view = prototype100();
    const text = compactAiReadView(view)!;
    const decoded = decodeAiReadView(text).view;
    expect(decoded.nodes).toHaveLength(100);
    expect(decoded.nodes).toEqual(sortedView(view).nodes);
    expect(decoded.boundaries).toEqual(sortedView(view).boundaries);
    expect(decoded.boundaries.filter(boundary => boundary.axis === 'children' && boundary.kind === 'exhausted')).toHaveLength(100);
    const noise = aiReadViewStrictNoise(text, view);
    console.info('100 节点 CTV2 严格噪声', noise);
    expect(noise.noise).toBeGreaterThan(0);
    expect(noise.noise).toBeLessThan(1);
  });

  it('确认只按字面投影，不由执行者推断', () => {
    const view: TreeView = {
      rootId: 'node-rev-1700000000000-0000000000000001', focusId: 'node-rev-1700000000000-0000000000000001',
      nodes: [
        viewNode({ id: 'node-rev-1700000000000-0000000000000001', title: '人执行但未载确认', currentChange: { revisionId: 'rev-1700000000000-0000000000000001', by: 'human' } }),
        viewNode({ id: 'node-rev-1700000001000-0000000000000001', parentId: 'node-rev-1700000000000-0000000000000001', title: 'AI 执行但已由人确认', confirmation: 'humanConfirmed', currentChange: { revisionId: 'rev-1700000001000-0000000000000001', by: 'ai' } }),
      ],
      refs: [], boundaries: [], complete: true, stamp: 7,
    };
    const decoded = decodeAiReadView(compactAiReadView(view)!).view;
    expect(decoded.nodes.find(node => node.id === 'node-rev-1700000000000-0000000000000001')?.confirmation).toBeUndefined();
    expect(decoded.nodes.find(node => node.id === 'node-rev-1700000001000-0000000000000001')?.confirmation).toBe('humanConfirmed');
  });

  it('页内语法说明覆盖版本、桶表拼接、默认值、引用与边界，不要求额外解码函数', () => {
    expect(AI_READ_VIEW_GUIDE).toContain('CTV2');
    expect(AI_READ_VIEW_GUIDE).toContain('includeDetails');
    expect(AI_READ_VIEW_GUIDE).toContain('detail');
    expect(AI_READ_VIEW_GUIDE).toContain('完整 JSON');
    expect(AI_READ_VIEW_GUIDE).toContain('focus');
    expect(AI_READ_VIEW_GUIDE).not.toContain('read_node');
    expect(AI_READ_VIEW_GUIDE).toContain('<k>');
    expect(AI_READ_VIEW_GUIDE).toContain('node-rev-');
    expect(AI_READ_VIEW_GUIDE).toContain('~ce=1-100');
    expect(AI_READ_VIEW_GUIDE).toContain('不需要额外解码工具');
  });
});
