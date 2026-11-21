/**
 * 把《认知树.md》节点章节里的「引用」行译成正式引用边。
 *
 * 职责：按手稿的三种分类、箭头、树内节点或外部材料链接，保留原方向与目标；
 * 「剪除理由」译成 part，外部材料同时核对其仓库相对定位。
 * 边界：手稿括注说明不是 Ref 字段，只校验形状，不塞进运行时类型；不把外部材料展开成另一棵树。
 * 协作：manuscript 把 tree 解析出的章节与节点传进来；内核按 Ref 原样保存。
 */
import type { Ref, RefKind, RefTarget, SeedNode } from '@cognition-tree/kernel/types';
import { ManuscriptError, splitTopLevel } from './source';
import type { NodeSection, OverviewNode } from './tree';

/** 手稿引用分类到内核引用种类的唯一对应。 */
const REF_KINDS: Readonly<Record<string, RefKind>> = {
  依赖前提: 'premise',
  同类实例: 'example',
  与事实冲突: 'conflict',
};

/**
 * 把手稿的引用行逐段译成正式引用边。
 * @param overview 概览顺序，决定引用边的输出顺序
 * @param sections 节点章节，提供每个节点的「引用」原文
 * @param nodes 已构造的节点，用于核对树内目标
 * @returns 保持原方向、类型与目标的引用边；每段都参与翻译
 * @throws ManuscriptError 分类、目标或树内剪除理由无法可靠对应时
 */
export function buildRefs(
  overview: readonly OverviewNode[],
  sections: ReadonlyMap<string, NodeSection>,
  nodes: ReadonlyMap<string, SeedNode>,
): Ref[] {
  const refs: Ref[] = [];
  for (const entry of overview) {
    const field = sections.get(entry.id)?.fields.get('引用');
    if (field === undefined) continue;
    const segments = splitTopLevel(field.value, '；', field.line).map((segment) => segment.trim());
    if (segments.some((segment) => segment === '')) throw new ManuscriptError(field.line, `节点 ${entry.id} 的引用有空段`);
    segments.forEach((segment, index) => {
      const match = /^(依赖前提|同类实例|与事实冲突)\s*→\s*(.+)$/.exec(segment);
      if (match === null) throw new ManuscriptError(field.line, `节点 ${entry.id} 的引用无法识别「${segment}」`);
      const kind = REF_KINDS[match[1]];
      if (kind === undefined) throw new ManuscriptError(field.line, `节点 ${entry.id} 的引用类型「${match[1]}」没有对应`);
      const target = parseRefTarget(match[2].trim(), field.line, nodes);
      refs.push({ id: `ref-${entry.id}-${index + 1}`, from: entry.id, kind, target });
    });
  }
  return refs;
}

/**
 * 译一段引用目标：外部材料链接或树内节点。
 *
 * 手稿链接后的括注说明不是正式 Ref 的字段；这里只核对它确实是括注或「的……」说明，
 * 不塞进运行时类型。目标本身（doc/part 或节点/剪除理由）必须能可靠译出。
 * @param text 去掉分类与箭头后的原文
 * @param line 原文行号，1 起算
 * @param nodes 已构造的节点
 * @returns 外部材料定位符或树内节点 ID；「剪除理由」保留 part
 * @throws ManuscriptError 目标语法、仓库路径或节点引用不可靠时
 */
function parseRefTarget(text: string, line: number, nodes: ReadonlyMap<string, SeedNode>): RefTarget {
  const link = /^\[([^\]]+)\]\(([^)]+)\)(.*)$/.exec(text);
  if (link !== null) {
    const [, label, doc, tail] = link;
    assertRepoRelativePath(doc, line);
    const rest = tail.trim();
    if (rest !== '' && !(rest.startsWith('（') && rest.endsWith('）')) && !/^的\S+$/.test(rest)) {
      throw new ManuscriptError(line, `引用目标后的说明无法识别「${rest}」`);
    }
    const part = /^认知事件\s+(E\d+)$/.exec(label.trim());
    return part === null ? { doc } : { doc, part: part[1] };
  }
  const node = /^(T1(?:\.\d+)*)(?:\s+的剪除理由)?(?:\s*（.*）)?$/.exec(text);
  if (node === null) throw new ManuscriptError(line, `无法识别的引用目标「${text}」`);
  const nodeId = node[1];
  const target = nodes.get(nodeId);
  if (target === undefined) throw new ManuscriptError(line, `引用目标节点 ${nodeId} 不在种子节点里`);
  if (text.includes('的剪除理由')) {
    if (target.state !== 'prune' || target.pruneReason === undefined) {
      throw new ManuscriptError(line, `引用目标 ${nodeId} 没有可引用的剪除理由`);
    }
    return { nodeId, part: 'pruneReason' };
  }
  return { nodeId };
}

/**
 * 校验外部材料定位符是仓库内相对路径。
 * @param doc 手稿链接里的目标
 * @param line 原文行号，1 起算
 * @throws ManuscriptError 绝对路径、Windows 路径或越出仓库时
 */
function assertRepoRelativePath(doc: string, line: number): void {
  if (doc === '' || doc.startsWith('/') || doc.includes('\\') || doc.split('/').includes('..')) {
    throw new ManuscriptError(line, `外部材料定位符「${doc}」不是仓库内相对路径`);
  }
}
