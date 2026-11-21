/**
 * 节点来历。
 *
 * 职责：说明一个节点在树里从哪来：普通节点（含根）、补充、勘误，还是旧判断的替代候选。
 * 边界：来历只描述节点与旧判断的关系，不表示确认，也不决定替代是否已执行。
 * 协作：node 的已保存节点、read 的节点行与 seed 的种子节点共用这一形状。
 */
import type { NodeId } from './ids';

export type Origin =
  | { kind: 'branch' }
  | { kind: 'supplement' }
  | { kind: 'erratum' }
  | {
      kind: 'replacement';
      /** 拟替代的旧节点 ID；根没有同级，不能被替代。 */
      replacesId: NodeId;
      /** 替代是否已执行；由有无确认不决定。 */
      status: 'proposed' | 'applied';
    };
