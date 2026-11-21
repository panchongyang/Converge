/**
 * 写侧结构原语（内核接口单 §3.1）。输入来自已校验的 commands，不读取树、推断意图或识别 actor。
 * 这里组装新行与实际效果，不就地修改旧行；是否及如何随日志提交由 models 决定。
 */
import type { BranchState, CognitionNode, EffectItem, Origin } from '../types';

/** 显式状态写入。剪除携带当前理由和复活条件；非剪状态不继续挂着旧的剪除信息。 */
export type BranchStateChange =
  | { state: 'prune'; pruneReason: string; reviveWhen: string }
  | { state: 'keep' | 'open' };

/** 一条实际变化的节点行及同一变化的日志效果。仅关联历史的节点不产生此项。 */
export interface NodeEffect {
  node: CognitionNode;
  effect: EffectItem;
}

/**
 * 创建一个新节点和对应的新增效果，不触及父节点或替代对象。
 * @param fields 已分配 ID、真实父节点、独立正文和已校验的来历
 * @param change 明确选择的初始状态及剪除信息
 * @returns 新行及未带 beforeState 的新增效果
 */
export function insertNode(
  fields: Pick<CognitionNode, 'id' | 'parentId' | 'body' | 'origin'>,
  change: BranchStateChange,
): NodeEffect {
  return {
    node: { ...fields, ...change },
    effect: { nodeId: fields.id, afterState: change.state },
  };
}

/**
 * 保留节点身份、正文、父子关系及来历，只替换分支状态与当前剪除信息。
 * @param original 事务内读到的原节点
 * @param change 已校验的目标状态及剪除信息；重新启用会移除当前剪除信息
 * @returns 新行和实际状态效果，原状态未载用 null
 */
export function changeState(original: CognitionNode, change: BranchStateChange): NodeEffect {
  const node: CognitionNode = { ...original, ...change };
  if (change.state !== 'prune') {
    delete node.pruneReason;
    delete node.reviveWhen;
  }
  return {
    node,
    effect: { nodeId: original.id, beforeState: original.state ?? null, afterState: change.state },
  };
}

/**
 * 只替换节点的来历，保留分支状态，因此效果前后状态相同。
 * @param node 当前分支状态可知的原节点
 * @param origin 已校验的新来历
 * @returns 新行及仅来历发生变化的效果
 */
export function changeOrigin(node: CognitionNode & { state: BranchState }, origin: Origin): NodeEffect {
  return {
    node: { ...node, origin },
    effect: { nodeId: node.id, beforeState: node.state, afterState: node.state },
  };
}
