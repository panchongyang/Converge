/**
 * 内存存储的未确认索引（接口单 3.3 的“未确认部分索引”职责）。
 *
 * 职责：维护“哪些形成记录仍有未确认节点指向”与“哪些导入判断尚未确认”两张增量索引；
 * 每次提交只根据本次改动的节点重算受影响修订的节点集合，不扫描整棵树或全部待确认项。
 * 形成记录按执行者分成人 / AI 两条按 (at, revisionId) 排序的索引，导入判断按节点 ID 排序；
 * 同一修订只出现一次，nodeIds 只列仍指向它且未确认的节点。
 * 边界：不判断确认是否有效（由 commands 在写事务内核对）；不解释正文，只保留标题与叙述。
 * 协作：commit 在发布前调用 prepare 得到新根与增量集合，发布时才 apply；
 * snapshot 持有捕获的索引根，按游标分批读。
 */
import type {
  CognitionNode,
  DailyActor,
  NodeId,
  PendingTarget,
  Revision,
  RevisionId,
} from '../../types';
import { CognitionError } from '../../types';
import { compareIds } from '../../utils';
import { OrderedMap } from './ordered-map';
import {
  compareImportKeys,
  compareTimeKeys,
  revisionTimeKey,
  type ImportKey,
  type TimeKey,
} from './keys';

/** 一条仍有未确认节点的形成记录；nodeIds 只列仍指向它且未人确认的节点。 */
export interface PendingFormationRecord {
  readonly revisionId: RevisionId;
  readonly at: string;
  readonly by: DailyActor;
  readonly summary: string;
  readonly nodeIds: NodeId[];
}

/** 一条尚无日常变更、导入时确认程度为 unconfirmed 的判断。 */
export interface PendingImportRecord {
  readonly nodeId: NodeId;
  readonly title: string;
}

/** 未确认索引的两类根；快照捕获后旧根继续服务已打开的读。 */
export interface UnconfirmedRoots {
  readonly human: OrderedMap<TimeKey, PendingFormationRecord>;
  readonly ai: OrderedMap<TimeKey, PendingFormationRecord>;
  readonly imports: OrderedMap<ImportKey, PendingImportRecord>;
}

/** 一次节点写入的前后行；用于增量更新未确认索引。 */
export interface NodeChange {
  readonly id: NodeId;
  readonly before: CognitionNode | null;
  readonly after: CognitionNode;
}

/** 发布前准备好的未确认索引变化；beforeCommit 失败时整组丢弃。 */
export interface PreparedUnconfirmed {
  /** 本次提交后的索引根。 */
  readonly roots: UnconfirmedRoots;
  /** 受影响的修订到新节点集合；null 表示集合已空、可从当前指针表删除。 */
  readonly pointers: Map<RevisionId, Set<NodeId> | null>;
  /** 受影响的修订到新待确认记录；null 表示从待确认表删除。 */
  readonly entries: Map<RevisionId, PendingFormationRecord | null>;
}

/**
 * 判断节点是否仍以某形成记录作为未确认的当前变更。
 * 确认程度缺键按“尚未人确认”处理；手稿未载只影响显示，不影响这条待确认定义。
 * @param node 已提交或事务内的节点行
 * @returns 有 currentChange 且未标为人确认时为 true
 */
function isPendingFormationNode(node: CognitionNode): boolean {
  return node.currentChange !== undefined && node.confirmation !== 'humanConfirmed';
}

/**
 * 判断节点是否是尚无日常变更、导入时明确标为 unconfirmed 的判断。
 * @param node 已提交或事务内的节点行
 * @returns 没有 currentChange 且 confirmation 为 unconfirmed 时为 true
 */
function isPendingImportNode(node: CognitionNode): boolean {
  return node.currentChange === undefined && node.confirmation === 'unconfirmed';
}

/**
 * 未确认索引的当前状态：指针反查、待确认记录缓存与两条排序根。
 * 这些字段只在提交成功时整体替换或增量更新，读快照不共享可变集合。
 */
export class UnconfirmedState {
  private _roots: UnconfirmedRoots;
  /** 修订 ID -> 仍指向它的节点集合；集合内节点可能已人确认或已改指针。 */
  private readonly pointers = new Map<RevisionId, Set<NodeId>>();
  /** 修订 ID -> 当前待确认记录；无记录表示当前没有未确认节点指向。 */
  private readonly entries = new Map<RevisionId, PendingFormationRecord>();

  /**
   * 创建空索引。
   * @param roots 可选的初始根，仅测试或恢复时使用
   */
  constructor(roots?: UnconfirmedRoots) {
    this._roots = roots ?? {
      human: OrderedMap.empty(compareTimeKeys),
      ai: OrderedMap.empty(compareTimeKeys),
      imports: OrderedMap.empty(compareImportKeys),
    };
  }

  /** 当前已提交的未确认索引根；读快照打开时捕获这一对象。 */
  get roots(): UnconfirmedRoots {
    return this._roots;
  }

  /**
   * 计算一次提交对未确认索引的影响；不修改当前状态，供发布前校验与失败丢弃。
   * @param changes 本次写入的节点前后行
   * @param getRevision 按 ID 取已提交或本次追加的修订
   * @param getNode 按 ID 取提交后的节点行，用于未改动但仍指向同一修订的节点
   * @returns 新的索引根与需在发布时应用的增量
   * @throws CognitionError 当 currentChange 指向不存在或不是形成记录的修订（invalid）
   */
  prepare(
    changes: readonly NodeChange[],
    getRevision: (revisionId: RevisionId) => Revision | null,
    getNode: (nodeId: NodeId) => CognitionNode | null,
  ): PreparedUnconfirmed {
    const touched = new Set<RevisionId>();
    for (const change of changes) {
      const beforeRevision = change.before?.currentChange?.revisionId;
      const afterRevision = change.after.currentChange?.revisionId;
      if (beforeRevision !== undefined) touched.add(beforeRevision);
      if (afterRevision !== undefined) touched.add(afterRevision);
    }

    const pointers = new Map<RevisionId, Set<NodeId> | null>();
    let human = this._roots.human;
    let ai = this._roots.ai;
    let imports = this._roots.imports;
    const entries = new Map<RevisionId, PendingFormationRecord | null>();

    for (const revisionId of touched) {
      const previous = this.pointers.get(revisionId);
      const next = previous === undefined ? new Set<NodeId>() : new Set(previous);
      for (const change of changes) {
        if (change.before?.currentChange?.revisionId === revisionId) next.delete(change.id);
        if (change.after.currentChange?.revisionId === revisionId) next.add(change.id);
      }
      pointers.set(revisionId, next.size === 0 ? null : next);

      const nodeIds: NodeId[] = [];
      for (const nodeId of next) {
        const node = getNode(nodeId);
        if (node !== null && isPendingFormationNode(node)) nodeIds.push(nodeId);
      }
      nodeIds.sort(compareIds);

      const existing = this.entries.get(revisionId) ?? null;
      if (nodeIds.length === 0) {
        if (existing !== null) {
          const key = revisionTimeKey(existing.at, revisionId);
          if (existing.by === 'human') human = human.delete(key);
          else ai = ai.delete(key);
          entries.set(revisionId, null);
        }
        continue;
      }

      const revision = getRevision(revisionId);
      if (revision === null || revision.kind !== 'formation' || revision.by === 'import') {
        throw new CognitionError(
          'invalid',
          `节点 ${nodeIds[0] ?? ''} 的当前变更 ${revisionId} 不是有效的形成记录，已回滚`,
        );
      }
      const record: PendingFormationRecord = {
        revisionId,
        at: revision.at,
        by: revision.by,
        summary: revision.summary,
        nodeIds,
      };
      const key = revisionTimeKey(record.at, revisionId);
      if (record.by === 'human') human = human.set(key, record);
      else ai = ai.set(key, record);
      entries.set(revisionId, record);
    }

    for (const change of changes) {
      const wasPending = change.before !== null && isPendingImportNode(change.before);
      const nowPending = isPendingImportNode(change.after);
      const key: ImportKey = [change.id];
      if (nowPending) {
        const current = imports.get(key);
        if (!wasPending || current === undefined || current.title !== change.after.body.title) {
          imports = imports.set(key, { nodeId: change.id, title: change.after.body.title });
        }
      } else if (wasPending) {
        imports = imports.delete(key);
      }
    }

    return {
      roots: { human, ai, imports },
      pointers,
      entries,
    };
  }

  /**
   * 发布 prepare 的结果；只在 beforeCommit 成功后的同步提交段调用。
   * @param prepared 已计算好的新根与增量集合
   */
  apply(prepared: PreparedUnconfirmed): void {
    this._roots = prepared.roots;
    for (const [revisionId, nodeIds] of prepared.pointers) {
      if (nodeIds === null) this.pointers.delete(revisionId);
      else this.pointers.set(revisionId, nodeIds);
    }
    for (const [revisionId, record] of prepared.entries) {
      if (record === null) this.entries.delete(revisionId);
      else this.entries.set(revisionId, record);
    }
  }
}

/**
 * 构造一条已确认待确认目标的输出形状；只复制记录里的数组，不暴露内部缓存。
 * @param record 形成记录的待确认项
 * @returns 可直接交给 confirm 的 PendingTarget
 */
export function pendingFormationTarget(record: PendingFormationRecord): PendingTarget {
  return {
    revisionId: record.revisionId,
    at: record.at,
    by: record.by,
    summary: record.summary,
    nodeIds: record.nodeIds.slice(),
  };
}

/**
 * 构造一条导入判断的待确认输出形状。
 * @param record 导入判断记录
 * @returns 可直接交给 confirm 的 PendingTarget
 */
export function pendingImportTarget(record: PendingImportRecord): PendingTarget {
  return { seedNodeId: record.nodeId, title: record.title };
}
