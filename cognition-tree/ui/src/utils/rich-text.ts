/**
 * 把节点正文里的 [标签](路径) 拆成文字段和出处段（纯计算）。
 * 出处是仓库相对路径或 http 链接；UI 用 HostBridge 打开，不自己 fetch。
 */

export type RichSegment = { type: 'text'; text: string } | { type: 'source'; label: string; doc: string };

/**
 * 拆分带出处链接的正文。
 * @param text 节点正文的一段
 * @returns 依次排列的文字段与出处段
 */
export function parseRich(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'source', label: m[1], doc: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}
