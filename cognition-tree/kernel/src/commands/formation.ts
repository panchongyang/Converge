/** 事务内意图校验的结果：models 用它一次提交相关节点、引用及形成记录。 */
import type { NodeEffect } from '../operations';
import type { Draft, FormationDetail, NodeId } from '../types';

/** 明细的动作参数；实际效果由每条节点变化提供，不单独维护两份列表。 */
type ActionFields<T extends FormationDetail = FormationDetail> = T extends FormationDetail
  ? Omit<T, 'effects'>
  : never;

/** 已校验的形成写入计划；首项是操作的目标节点。 */
export interface FormationPlan {
  changes: [NodeEffect, ...NodeEffect[]];
  action: ActionFields;
  summary: string;
  /** 仅给历史关联，不能用于更新 currentChange 或确认程度。 */
  historyAnchor?: NodeId;
  /** 仅新增有此项；所有引用的起点都是首项的新节点。 */
  outgoing?: Draft['refs'];
}
