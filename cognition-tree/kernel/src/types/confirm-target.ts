/**
 * 确认目标：一次 `confirm` 指向的对象。
 *
 * 职责：描述二选一的确认目标——一条读到的形成记录，或一个尚无日常变更的导入判断。
 * 边界：只给目标定位，不含确认记录本身；确认不改变分支状态，也不触发替代。
 * 协作：revision 的 ConfirmationDetail、ports 的查重与 seed 之外的分页都引用它。
 */
import type { NodeId, RevisionId } from './ids';

/**
 * 确认目标，二选一：
 * revisionId 指读到的形成记录；seedNodeId 指尚无日常变更的导入判断。
 * 两个变体用 `?: never` 互斥，`{revisionId, seedNodeId}` 同时出现无法通过类型检查。
 *
 * 确认形成记录时，事务内核对它仍是至少一个实际受影响节点的 currentChange；
 * 只更新指针仍指向它的节点。对自举判断，仅当它仍无 currentChange 才能确认导入时的状态。
 */
export type ConfirmTarget =
  | {
      /** 要确认的形成记录 ID。 */
      revisionId: RevisionId;
      /** 导入判断目标与形成记录目标互斥。 */
      seedNodeId?: never;
    }
  | {
      /** 要确认的导入判断节点 ID。 */
      seedNodeId: NodeId;
      /** 形成记录目标与导入判断目标互斥。 */
      revisionId?: never;
    };
