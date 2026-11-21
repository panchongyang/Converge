/**
 * 一次性把仓库根《认知树.md》译成内核的 SeedTree。
 *
 * 职责：编排三个专用解析器——概览与节点（tree）、引用（refs）、形成记录（history），
 * 把同一份手稿原文合成为自举输入。
 * 边界：不读正式存储、不调用内核；不接受通用 Markdown 输入，只认这份手稿的固定排版。
 * 协作：bootstrap/index.ts 把构建器编译进来的原文传进来；内核 bootstrapTree 消费结果。
 */
import type { SeedTree } from '@cognition-tree/kernel/types';
import { buildHistory } from './history';
import { buildRefs } from './refs';
import { ManuscriptError } from './source';
import { parseTree } from './tree';

export { ManuscriptError } from './source';

/**
 * 把一份《认知树.md》原文译成 T1 的一次性种子。
 * @param raw 构建器以 ?raw 编译进来的手稿全文
 * @returns 沿用原 ID、原历史行序与时间精度的种子；每次调用都返回新对象
 * @throws ManuscriptError 手稿缺节、字段未知、引用或形成记录无法可靠映射时
 */
export function translateT1Manuscript(raw: string): SeedTree {
  if (raw.trim() === '') throw new ManuscriptError(1, '手稿原文为空');
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const tree = parseTree(lines);
  const nodesById = new Map(tree.nodes.map((node) => [node.id, node]));
  const refs = buildRefs(tree.overview, tree.sections, nodesById);
  const history = buildHistory(lines, tree.overview);
  return { treeId: 'T1', rootId: 'T1', nodes: tree.nodes, refs, history };
}
