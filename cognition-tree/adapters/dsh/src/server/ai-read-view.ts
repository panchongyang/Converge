/**
 * AI 读取视图的紧凑文本表示。
 *
 * 职责：把内核已经算好的 `TreeView` 投影成一段自包含、可逐行阅读的文本，供模型直接阅读；
 * 不重新查询、不推导确认、不改变节点顺序语义，也不依赖上一页的回包。
 * 边界：只做无损表示；节点数超过 128 或引用数超过 256 时立即返回 `undefined`，调用方继续使用原 JSON。
 * 详情模式（`includeDetails=true`）不经过本文件：工具直接输出内核的完整 JSON，避免把 detail 压掉。
 * 协作：`read_view` 工具把返回值作为文本交给模型；模型按本页桶表恢复可作下次 focus 的真实 ID。
 * 语法与字段含义见 `AI_READ_VIEW_GUIDE`，版本前缀为 CTV2。
 */
import type { TreeView } from '@cognition-tree/kernel/types';

/** 单页最多投影的节点数；超过时不做任何试投影，直接回退旧 JSON 表示。 */
const MAX_NODES = 128;
/** 单页最多投影的引用数；超过时同上。 */
const MAX_REFS = 256;
/** 紧凑文本的版本。字段或代码含义变化时递增，并同步更新 GUIDE。 */
const FORMAT_VERSION = 'CTV2';
/** 节点行中仅 link 使用的前缀；hit 不加前缀，省掉每行角色字节。 */
const LINK_PREFIX = '-';

/**
 * 供 `read_view` 工具定义使用的页内语法说明。
 * 面向模型：只解释怎样读当前页、怎样把短写拼成真实 nodeId；不描述宿主或内核实现。
 */
export const AI_READ_VIEW_GUIDE = `includeDetails 省略或 false 时，读取结果是 CTV2 紧凑文本（超 128 节点或 256 引用时退回 JSON）；includeDetails=true 时整页直接返回完整 JSON：同一 TreeView，每个节点（含为连通父链补入的 link）多一个 detail（NodeDetail：正文、状态、确认、来历与当前形成记录全文）。每页自包含。续读用原查询和本页的 cursor；版本 t 不作为读取参数；基于当前页新增或决定时可用作 expectedStamp。
首行：CTV2 n=… r=… t=… c=0|1 p=N root=… focus=… [cursor="…"]。n/r 是节点/引用数，c=1 已覆盖请求范围，c=0 且有 cursor 表示预算先到。N 是毫秒前缀长度。
ID 前缀：# 行给出 13 位毫秒的前 N 位，切换后续节点的前缀。不同的前缀按首次出现编号 1、2、3…；同值 # 再出现不重新编号。节点行 ID 只写后 13-N 位（沿用最近 # 行）：
  <后缀> = node-rev-<当前前缀+后缀>-0000000000000001
  <后缀>.<序号> = node-rev-<当前前缀+后缀>-<序号左补0到16位>
  末尾 -<后缀> 是碰撞后缀，原样接在序号后。页头、旁注、引用用显式 <k>.<后缀>；修订用 r<k>.<后缀>，拼成 rev-<第k个#前缀+后缀>-<16位序号>[-后缀]。
  JSON 字符串（如 "T1"、"含 空格"）是原样 ID：去掉外层引号并反转义后使用。
节点行：缩进表示真实父链（每层一空格）；link 行在 ID 前有 -，hit 无角色前缀。格式固定为：
  <缩进>[ -]<ID>|<state>|<confirmation>|<标题>
  state 用原词 keep/prune/open，confirmation 用原词 unconfirmed/humanConfirmed；未知留空。前三个未转义竖线分列，其后是转义标题。页内序号从 1 开始，只数节点行。
旁注不占节点行：
  @h=序号列表 表示这些节点初始修订由人执行；@-=序号列表 表示没有 currentChange；@o:s=… / @o:e=… 表示 supplement/erratum 来历。
  @18h,r1.80000 表示 18 号节点的非初始/后续修订（h 可省，默认 ai）；替代候选写 @19o=r,os=p|a,ot=<被替代ID>；父节点不在本页时写 p=<ID>。
  同名初始修订（节点 ID 去掉 node-）默认由 AI 执行；不同的修订或执行者用旁注明示，不表示人确认。
边界：~<两字母代码>=页内序号列表，如 ~ce=1-100；c=children、r=refs，s=scope、e=exhausted、b=budget。节点不在本页时列表项用 id:<ID>。
引用：R id="…" from=<ID> kind=p|e|c to=<ID> [part="…"]，外部材料用 doc="仓库相对定位"；方向始终 from→目标，p/e/c 表示前提/实例/冲突。
按桶表复制拼接完整 nodeId；要聚焦该节点读取正文，用它作新一次 read_view 的 focus 并传 includeDetails:true。本页没有的节点不要猜，继续 read_view。不需要额外解码工具或服务端状态。`;

/** 状态原词到原词的显式表；只用于校验与解码说明，不缩写。 */
const STATE_TEXT = { keep: 'keep', prune: 'prune', open: 'open' } as const;
/** 确认原词；未知用空字段。 */
const CONFIRM_TEXT = { unconfirmed: 'unconfirmed', humanConfirmed: 'humanConfirmed' } as const;
/** 引用类型到单字母代码。 */
const REF_CODE = { premise: 'p', example: 'e', conflict: 'c' } as const;

/** 可压缩的节点 ID：node-rev-<13位毫秒>-<16位序号>[-碰撞后缀]。 */
const NODE_ID = /^node-rev-(\d{13})-(\d{16})(?:-([A-Za-z0-9._-]+))?$/;
/** 可压缩的修订 ID：rev-<13位毫秒>-<16位序号>[-碰撞后缀]。 */
const REVISION_ID = /^rev-(\d{13})-(\d{16})(?:-([A-Za-z0-9._-]+))?$/;

/** 一次投影内的 ID 桶：毫秒前缀到 1 基桶号，按首次使用顺序编号。 */
interface IdBuckets {
  /** 本页共享的毫秒前缀长度，5–12；行内写剩余 13-N 位后缀。 */
  readonly prefixLength: number;
  readonly index: Map<string, number>;
  readonly prefixes: string[];
  /** 节点行当前使用的前缀；# 行切换后，节点 ID 只写后缀。 */
  current?: string;
  /** 页头/旁注/引用里显式桶号用的前缀行，放在节点行之后。 */
  readonly pending: string[];
}

/** JSON 字符串字面量；用于任意原样 ID、标题、游标、文档定位与局部名。 */
function quote(value: string): string {
  const text = JSON.stringify(value);
  return text === undefined ? '""' : text;
}

/** 把 16 位序号压成十进制；模型侧按固定规则左补 0 到 16 位。 */
function shortOrdinal(ordinal: string): string {
  return ordinal.replace(/^0+/, '') || '0';
}

/** 试算不同前缀长度的页内成本，选总字节最少的一档；只做本页 ID，不访问外部状态。 */
function choosePrefixLength(ids: readonly string[]): number {
  let best = 8;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let length = 5; length <= 12; length++) {
    const prefixes = new Set<string>();
    let matched = 0;
    for (const id of ids) {
      const match = NODE_ID.exec(id) ?? REVISION_ID.exec(id);
      if (match === null) continue;
      matched++;
      prefixes.add(match[1]!.slice(0, length));
    }
    // 桶表每行 #+前缀+换行；每个匹配 ID 还要写点号加剩余后缀。
    const cost = prefixes.size * (length + 2) + matched * (13 - length + 1);
    if (cost < bestCost) { best = length; bestCost = cost; }
  }
  return best;
}

/** 取得或登记一个毫秒前缀的桶号；只在页内计数。 */
function ensurePrefix(prefix: string, buckets: IdBuckets): number {
  let bucket = buckets.index.get(prefix);
  if (bucket === undefined) {
    buckets.prefixes.push(prefix);
    bucket = buckets.prefixes.length;
    buckets.index.set(prefix, bucket);
  }
  return bucket;
}

/** 显式 ID（页头、旁注、引用）使用桶号+后缀；新前缀的 # 行放在节点行之后。 */
function idToken(id: string, family: 'n' | 'r', buckets: IdBuckets): string {
  const match = (family === 'n' ? NODE_ID : REVISION_ID).exec(id);
  if (match === null) return quote(id);
  const milliseconds = match[1]!;
  const ordinal = match[2]!;
  const collision = match[3];
  const prefix = milliseconds.slice(0, buckets.prefixLength);
  const suffix = milliseconds.slice(buckets.prefixLength);
  const fresh = !buckets.index.has(prefix);
  const bucket = ensurePrefix(prefix, buckets);
  if (fresh) buckets.pending.push(`#${prefix}`);
  let short = `${family === 'r' ? 'r' : ''}${bucket}.${suffix}`;
  if (ordinal !== '0000000000000001') short += `.${shortOrdinal(ordinal)}`;
  if (collision !== undefined) short += `-${collision}`;
  return short;
}

/** 节点行的 ID：同一前缀只写一次 # 行，后续行只写 13-N 位后缀。 */
function nodeIdToken(id: string, buckets: IdBuckets, lines: string[]): string {
  const match = NODE_ID.exec(id);
  if (match === null) return quote(id);
  const milliseconds = match[1]!;
  const ordinal = match[2]!;
  const collision = match[3];
  const prefix = milliseconds.slice(0, buckets.prefixLength);
  const suffix = milliseconds.slice(buckets.prefixLength);
  if (buckets.current !== prefix) {
    lines.push(`#${prefix}`);
    ensurePrefix(prefix, buckets);
    buckets.current = prefix;
  }
  let short = suffix;
  if (ordinal !== '0000000000000001') short += `.${shortOrdinal(ordinal)}`;
  if (collision !== undefined) short += `-${collision}`;
  return short;
}

/** 标题用反斜杠转义，分隔符 | 与换行不会截断节点行；解码端只做反转义。 */
function escapeTitle(title: string): string {
  const backslash = String.fromCharCode(92);
  let output = '';
  for (const character of title) {
    const code = character.codePointAt(0)!;
    if (code === 92) output += backslash + backslash;
    else if (code === 124) output += backslash + '|';
    else if (code === 10) output += backslash + 'n';
    else if (code === 13) output += backslash + 'r';
    else if (code < 0x20 || code === 0x7f) output += backslash + 'x' + code.toString(16).padStart(2, '0');
    // 保留 UTF-8 不能直接承载的孤立代理项，也不把 Unicode 行分隔符当新节点行。
    else if ((code >= 0xd800 && code <= 0xdfff) || code === 0x2028 || code === 0x2029) output += backslash + 'u' + code.toString(16).padStart(4, '0');
    else output += character;
  }
  return output;
}

/** 节点状态原词；未载留空，不用缩写。 */
function stateText(state: ViewState): string {
  return state === undefined ? '' : STATE_TEXT[state];
}

/** 节点确认原词；未载留空，不从执行者推断。 */
function confirmText(confirmation: ViewConfirmation): string {
  return confirmation === undefined ? '' : CONFIRM_TEXT[confirmation];
}

/** 一行的节点主体：缩进 + 可选 link 前缀 + ID|state|confirmation|转义标题。 */
function nodeLine(node: TreeView['nodes'][number], depth: number, buckets: IdBuckets, lines: string[]): string {
  const role = node.role === 'link' ? LINK_PREFIX : '';
  return `${' '.repeat(depth)}${role}${nodeIdToken(node.id, buckets, lines)}|${stateText(node.state)}|${confirmText(node.confirmation)}|${escapeTitle(node.title)}`;
}

/** 生成节点的初始修订可由 node-<修订 ID> 直接推出；其它情况才写旁注。 */
function initialRevision(node: TreeView['nodes'][number]): string | undefined {
  if (!node.id.startsWith('node-') || node.currentChange === undefined) return undefined;
  return node.id.slice('node-'.length) === node.currentChange.revisionId ? node.currentChange.revisionId : undefined;
}

/**
 * 把逐节点例外收成两类短旁注：同值组用 `@h=1,3` / `@-=5` / `@o:s=7`，
 * 只能逐节点的后续修订或替代目标用 `@18h,r1.80000`。不占节点行。
 */
function buildNotes(view: TreeView, indexById: Map<string, number>, buckets: IdBuckets): string[] {
  const groups = new Map<string, number[]>();
  const perNode = new Map<number, string[]>();
  /** 同值例外按代码聚成一组，页内索引用连续段压缩。 */
  const addGroup = (code: string, index: number): void => {
    const indices = groups.get(code) ?? [];
    indices.push(index);
    groups.set(code, indices);
  };
  const pageIds = new Set(indexById.keys());
  for (const node of view.nodes) {
    const pageIndex = indexById.get(node.id);
    if (pageIndex === undefined) continue;
    const tokens: string[] = [];
    // 断链兜底：真实父节点不在本页时用旁注保留，不把父链改成 null。
    if (node.parentId !== null && !pageIds.has(node.parentId)) tokens.push(`p=${idToken(node.parentId, 'n', buckets)}`);
    if (node.origin.kind === 'supplement') addGroup('o:s', pageIndex);
    else if (node.origin.kind === 'erratum') addGroup('o:e', pageIndex);
    else if (node.origin.kind === 'replacement') {
      tokens.push('o=r', `os=${node.origin.status === 'applied' ? 'a' : 'p'}`, `ot=${idToken(node.origin.replacesId, 'n', buckets)}`);
    }
    if (node.currentChange === undefined) addGroup('-', pageIndex);
    else if (initialRevision(node) === undefined) {
      if (node.currentChange.by === 'human') tokens.unshift('h');
      tokens.push(idToken(node.currentChange.revisionId, 'r', buckets));
    } else if (node.currentChange.by === 'human') addGroup('h', pageIndex);
    if (tokens.length > 0) perNode.set(pageIndex, tokens);
  }
  const notes: string[] = [];
  for (const code of ['h', '-', 'o:s', 'o:e']) {
    const indices = groups.get(code);
    if (indices !== undefined && indices.length > 0) notes.push(`@${code}=${formatIndices(indices)}`);
  }
  for (const [index, tokens] of [...perNode].sort((left, right) => left[0] - right[0])) {
    notes.push(`@${index}${tokens.join(',')}`);
  }
  return notes;
}

/** 两位边界代码：children/refs + scope/exhausted/budget。 */
function boundaryCode(axis: string, kind: string): string {
  return `${axis === 'children' ? 'c' : 'r'}${kind === 'scope' ? 's' : kind === 'exhausted' ? 'e' : 'b'}`;
}

/** 把升序页内序号压成连续段，如 1-100；少量离散序号保留逗号列表。 */
function formatIndices(indices: readonly number[]): string {
  const sorted = [...indices].sort((left, right) => left - right);
  const parts: string[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    if (end - start >= 1) parts.push(`${sorted[start]}-${sorted[end]}`);
    else parts.push(String(sorted[start]));
    start = end + 1;
  }
  return parts.join(',');
}

type ViewState = TreeView['nodes'][number]['state'];
type ViewConfirmation = TreeView['nodes'][number]['confirmation'];

/**
 * 判断一页是否落在紧凑表示的硬护栏内：节点数不超过 128 且引用数不超过 256。
 * 只比较条数，不读节点或引用内容；内核可在构造候选输出前先调用，宽页直接沿用旧 JSON，
 * 不产生无效的整页拷贝。
 * @param nodeCount 本页节点数
 * @param refCount 本页引用数
 * @returns true 表示可以尝试 compactAiReadView；false 表示应直接使用旧 JSON 表示
 */
export function canCompactAiReadView(nodeCount: number, refCount: number): boolean {
  return nodeCount <= MAX_NODES && refCount <= MAX_REFS;
}

/**
 * 把一页视图投影成自包含的紧凑文本。
 * 节点行只保留 `ID|state|confirmation|title` 四段，来历、修订例外和边界另用短旁注；
 * 毫秒只写页内共享的前缀，行内后缀与序号仍可原样复制拼回真实 ID。
 * 节点数 >128 或引用数 >256 时立即返回 undefined，不做部分投影，调用方沿用旧 JSON。
 * @param view 内核读取结果；本函数只读，不修改传入对象。
 * @returns 可交给模型的稳定文本；超量或结构无法安全投影时为 undefined。
 */
export function compactAiReadView(view: TreeView): string | undefined {
  if (!canCompactAiReadView(view.nodes.length, view.refs.length)) return undefined;

  // 先收集会进入 ID 短写的全部值，按本页成本挑前缀长度；不查询任何外部状态。
  const ids: string[] = [];
  for (const node of view.nodes) {
    ids.push(node.id);
    if (node.currentChange !== undefined) ids.push(node.currentChange.revisionId);
    if (node.origin.kind === 'replacement') ids.push(node.origin.replacesId);
  }
  for (const ref of view.refs) {
    ids.push(ref.from);
    if ('nodeId' in ref.target && ref.target.nodeId !== undefined) ids.push(ref.target.nodeId);
  }
  const buckets: IdBuckets = { prefixLength: choosePrefixLength(ids), index: new Map(), prefixes: [], pending: [] };

  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const children = new Map<string, TreeView['nodes']>();
  const roots: TreeView['nodes'] = [];
  for (const node of view.nodes) {
    if (node.parentId !== null && byId.has(node.parentId)) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    } else {
      roots.push(node);
    }
  }
  // 聚合时保留收到的同父行顺序，不在适配层用字典序重新解释内核的索引顺序。
  const lines: string[] = [];
  const order: string[] = [];
  const seen = new Set<string>();
  /** 深度优先保留同父行顺序，父链由缩进表达。@param node 当前节点行。@param depth 到本页显示根的深度。 */
  const emit = (node: TreeView['nodes'][number], depth: number): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    order.push(node.id);
    lines.push(nodeLine(node, depth, buckets, lines));
    for (const child of children.get(node.id) ?? []) emit(child, depth + 1);
  };
  const root = byId.get(view.rootId);
  if (root !== undefined) emit(root, 0);
  for (const node of roots) emit(node, 0);
  for (const node of view.nodes) emit(node, 0);

  const indexById = new Map(order.map((id, index) => [id, index + 1]));
  const notes = buildNotes(view, indexById, buckets);

  const refLines: string[] = [];
  for (const ref of view.refs) {
    const fields = ['R', `id=${quote(ref.id)}`, `from=${idToken(ref.from, 'n', buckets)}`, `kind=${REF_CODE[ref.kind]}`];
    if ('nodeId' in ref.target && ref.target.nodeId !== undefined) {
      fields.push(`to=${idToken(ref.target.nodeId, 'n', buckets)}`);
    } else if ('doc' in ref.target && ref.target.doc !== undefined) {
      fields.push(`doc=${quote(ref.target.doc)}`);
    }
    if (ref.target.part !== undefined) fields.push(`part=${quote(ref.target.part)}`);
    refLines.push(fields.join(' '));
  }

  const boundaryGroups = new Map<string, { indices: number[]; external: string[] }>();
  for (const boundary of view.boundaries) {
    const code = boundaryCode(boundary.axis, boundary.kind);
    const group = boundaryGroups.get(code) ?? { indices: [], external: [] };
    const pageIndex = indexById.get(boundary.nodeId);
    if (pageIndex === undefined) group.external.push(`id:${idToken(boundary.nodeId, 'n', buckets)}`);
    else group.indices.push(pageIndex);
    boundaryGroups.set(code, group);
  }
  const boundaryLines = [...boundaryGroups].map(([code, group]) => {
    const parts = [formatIndices(group.indices), ...group.external].filter((part) => part.length > 0);
    return `~${code}=${parts.join(',')}`;
  });

  // 页头最后组装：root/focus 也可能分配新的前缀桶。
  const header = [
    FORMAT_VERSION,
    `n=${view.nodes.length}`,
    `r=${view.refs.length}`,
    `t=${view.stamp}`,
    `c=${view.complete ? 1 : 0}`,
    `p=${buckets.prefixLength}`,
    `root=${idToken(view.rootId, 'n', buckets)}`,
    `focus=${idToken(view.focusId, 'n', buckets)}`,
    ...(view.cursor === undefined ? [] : [`cursor=${quote(view.cursor)}`]),
  ].join(' ');
  return [header, ...lines, ...buckets.pending, ...notes, ...boundaryLines, ...refLines].join(String.fromCharCode(10));
}
