/**
 * 架构图的固定布局渲染器。节点、箭头含义来自 .mmd 正文，坐标来自同文件的注释。
 * 只处理这三张图使用的 flowchart 写法，不替代结构图的 Mermaid 渲染。
 */
const WIDTH = 960;
const STYLE = `
    text { font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; fill: #142940; }
    .heading { font-size: 26px; font-weight: 700; }
    .caption { font-size: 16px; fill: #455d78; }
    .badge { font-size: 14px; font-weight: 600; fill: #285390; }
    .zone { fill: #f7f9fc; stroke: #cbd7e6; }
    .zone.ui { fill: #f3f7fd; stroke: #c1d3ed; }
    .zone.kernel { fill: #f4f7fb; stroke: #c6d4e5; }
    .zone.store { fill: #f3f9f7; stroke: #c1dad2; }
    .zone-title { font-size: 16px; font-weight: 600; fill: #365573; }
    .card { fill: #ffffff; stroke: #a4b6cc; stroke-width: 1.25; }
    .card.ui { fill: #e8f0ff; stroke: #8ba8d8; }
    .card.kernel { fill: #e7eef8; stroke: #93adcb; }
    .card.port { fill: #f1edfa; stroke: #a99acb; }
    .card.store { fill: #e6f3ef; stroke: #86b5a8; }
    .card.future { fill: #f8fafc; stroke: #8293ab; stroke-dasharray: 5 4; }
    .node-title { font-size: 18px; font-weight: 600; }
    .node-detail { font-size: 16px; fill: #405670; }
    .edge { fill: none; stroke: #526783; stroke-width: 1.8; stroke-linejoin: round; }
    .edge.dashed { stroke-dasharray: 5 4; }
    .edge-label { font-size: 14px; fill: #334e6c; }
`;

/** 转义 value，使其可作为 SVG 文本或属性值。 */
function xml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

/** 从 source 中读取节点标题、依赖方向、线型和标签，不从排版注释复写关系。 */
function readGraph(source) {
  const graph = source.split(/^flowchart [A-Z]+\r?$/m)[1];
  if (!graph) throw new Error("缺少 flowchart 定义");
  const nodes = new Map();
  const edges = [];
  for (const line of graph.split(/\r?\n/).map((line) => line.trim())) {
    if (!line || /^(?:%%|(?:classDef|class|subgraph) |end$)/.test(line)) continue;
    const node = line.match(/^(\w+)\["([^"]+)"\](?::{3}\w+)?$/);
    const edge = line.match(/^(\w+) (-->|-\.->)(?:\|"([^"]+)"\|)? (\w+)$/);
    if (node && !nodes.has(node[1])) nodes.set(node[1], node[2]);
    else if (edge) edges.push({ from: edge[1], to: edge[4], label: edge[3], dashed: edge[2] === "-.->" });
    else throw new Error(`无法读取架构图声明或节点重复：${line}`);
  }
  return { nodes, edges };
}

/** 把 .mmd 图源 source 转成静态 SVG，节点和走线都按图源的固定坐标绘制。 */
export function renderArchitecture(source) {
  const title = source.match(/^title: ([^\r\n]+)$/m)?.[1];
  const layoutBlock = source.match(/^%% layout\r?\n([\s\S]+?)^%% \/layout$/m)?.[1];
  if (!title || !layoutBlock) throw new Error("缺少标题或 layout 布局块");
  const layout = JSON.parse(layoutBlock.replace(/^%% /gm, ""));
  const { nodes, edges } = readGraph(source);
  const edgeKeys = new Set(edges.map(({ from, to }) => `${from}>${to}`));
  if (nodes.size !== Object.keys(layout.nodes).length || edgeKeys.size !== edges.length || edgeKeys.size !== Object.keys(layout.routes).length) {
    throw new Error("节点或箭头的声明与布局数量不匹配");
  }
  const parts = [
    "<!-- 由同名 .mmd 重绘；编辑图源后运行 pnpm run diagrams。 -->",
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${layout.height}" viewBox="0 0 ${WIDTH} ${layout.height}" role="img" aria-labelledby="title caption">`,
    `  <title id="title">${xml(title)}</title>`,
    `  <desc id="caption">${xml(layout.caption)}</desc>`,
    "  <defs>",
    `    <style>${STYLE}    </style>`,
    '    <marker id="arrow" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">',
    '      <path d="M 0 0.75 L 10 5 L 0 9.25 Z" fill="#526783"/>',
    "    </marker>",
    "  </defs>",
    `  <rect width="${WIDTH}" height="${layout.height}" fill="#ffffff"/>`,
    '  <rect x="24" y="27" width="4" height="48" rx="2" fill="#376eb8"/>',
    `  <text x="40" y="49" class="heading">${xml(title.replace(/（目标设计.*）$/, ""))}</text>`,
    `  <text x="40" y="74" class="caption">${xml(layout.caption)}</text>`,
    '  <rect x="838" y="26" width="98" height="34" rx="17" fill="#eaf1fc"/>',
    '  <text x="887" y="48" text-anchor="middle" class="badge">目标设计</text>',
  ];
  for (const [x, y, w, h, label, tone] of layout.zones) {
    parts.push(`  <rect class="zone ${xml(tone)}" x="${x}" y="${y}" width="${w}" height="${h}" rx="16"/>`);
    parts.push(`  <text class="zone-title" x="${x + 20}" y="${y + 30}">${xml(label)}</text>`);
  }
  for (const { from, to, label, dashed } of edges) {
    const key = `${from}>${to}`;
    const route = layout.routes[key];
    if (!nodes.has(from) || !nodes.has(to) || !route?.[0] || Boolean(label) !== Boolean(route[1])) throw new Error(`箭头或标签缺少布局：${key}`);
    const [points, labelPosition] = route;
    parts.push(`  <polyline class="edge${dashed ? " dashed" : ""}" data-from="${from}" data-to="${to}" points="${points.map((p) => p.join(",")).join(" ")}" marker-end="url(#arrow)"/>`);
    if (label) {
      const [x, y, anchor = "middle"] = labelPosition;
      for (const [index, line] of label.split("<br/>").entries()) {
        parts.push(`  <text class="edge-label" x="${x}" y="${y + 18 * index}" text-anchor="${xml(anchor)}">${xml(line.trim())}</text>`);
      }
    }
  }
  for (const [id, label] of nodes) {
    if (!layout.nodes[id]) throw new Error(`节点缺少布局：${id}`);
    const [x, y, w, h, tone = ""] = layout.nodes[id];
    const lines = label.split("<br/>");
    const firstBaseline = y + h / 2 + 6 - (lines.length - 1) * 9.5;
    parts.push(`  <g data-node="${id}">`);
    parts.push(`    <rect class="card ${xml(tone)}" x="${x}" y="${y}" width="${w}" height="${h}" rx="9"/>`);
    for (const [index, line] of lines.entries()) {
      const cls = index === 0 ? "node-title" : "node-detail";
      parts.push(`    <text class="${cls}" x="${x + w / 2}" y="${firstBaseline + 19 * index}" text-anchor="middle">${xml(line.trim())}</text>`);
    }
    parts.push("  </g>");
  }
  return [...parts, "</svg>", ""].join("\n");
}
