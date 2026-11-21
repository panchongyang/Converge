/**
 * 内存存储的写事务句柄。
 *
 * 职责：在单树事务内提供按 ID 读当前行、按确认目标查重、写入节点/引用/修订的能力；
 * 所有写入先落在本对象的增量表里，work 返回后才可能合并进已提交状态。
 * 边界：不理解树语义，不校验正文可否覆盖、状态是否适用；这些由 commands 保证。
 * 事务结束（work 返回或抛错）后句柄立即失效，外部留存的引用不能再读写，防止改动逃逸到提交段。
 * 协作：store.transact 创建并只把它交给 work；store 提交时从 changes/refs/revisions 取增量，
 * 通过 getNode/getRevision 支撑未确认索引的增量重算。
 */
import type {
  CognitionNode,
  ConfirmTarget,
  NodeId,
  Ref,
  RefId,
  Revision,
  RevisionId,
  WriteTransaction,
} from '../../types';
import { CognitionError } from '../../types';
import { cloneNode, cloneRef, cloneRevision } from './clone';
import { confirmationKey, confirmationTargetOf, sameTarget } from './confirmation';
import { readNodeFromIndex } from './node-table';
import type { TreeRecord } from './tree-record';
import type { NodeChange } from './unconfirmed';

/** 写事务内的增量工作区；读已提交行时透传到树记录的表。 */
export class WriteTransactionImpl implements WriteTransaction {
  private active = true;
  /** 本次写入后的节点行，按首次写入顺序记录。 */
  private readonly nodeAfter = new Map<NodeId, CognitionNode>();
  /** 节点在本次事务之前的已提交行；新节点为 null。 */
  private readonly nodeBefore = new Map<NodeId, CognitionNode | null>();
  /** 节点首次写入的顺序，保证提交增量稳定。 */
  private readonly nodeOrder: NodeId[] = [];
  private readonly refList: Ref[] = [];
  private readonly refIds = new Set<RefId>();
  private readonly revisionList: Revision[] = [];
  private readonly revisionIds = new Set<RevisionId>();

  /**
   * 从事务起点记录创建句柄。
   * @param base 事务开始时该树的已提交状态；createNew 时是空树记录
   */
  constructor(private readonly base: TreeRecord) {}

  /**
   * 确认句柄仍处于 work 执行期；逃逸调用属于编程错误，直接抛错。
   */
  private assertActive(): void {
    if (!this.active) {
      throw new Error('写事务已结束：不能在 work 返回后继续读取或写入事务句柄');
    }
  }

  /**
   * 按 ID 读事务内可见的完整节点；本次已改写的行优先。
   * @param nodeId 目标节点
   * @returns 节点副本；不存在时为 null
   */
  async readNode(nodeId: NodeId): Promise<CognitionNode | null> {
    this.assertActive();
    const pending = this.nodeAfter.get(nodeId);
    if (pending !== undefined) return cloneNode(pending);
    const committed = readNodeFromIndex(this.base.nodes, nodeId);
    return committed === null ? null : cloneNode(committed);
  }

  /**
   * 按 ID 读事务内可见的修订；本次已追加的记录优先。
   * @param revisionId 目标修订
   * @returns 修订副本；不存在时为 null
   */
  async readRevision(revisionId: RevisionId): Promise<Revision | null> {
    this.assertActive();
    const pending = this.revisionList.find((revision) => revision.id === revisionId);
    if (pending !== undefined) return cloneRevision(pending);
    const committed = this.base.revisions.current(revisionId);
    return committed === null ? null : cloneRevision(committed);
  }

  /**
   * 按确认目标查重，同时看已提交的确认索引与本次事务已追加的确认记录。
   * @param target 二选一的确认目标
   * @returns 该目标已有确认记录时为 true
   */
  async hasConfirmation(target: ConfirmTarget): Promise<boolean> {
    this.assertActive();
    if (this.base.confirmedTargets.has(confirmationKey(target))) return true;
    for (const revision of this.revisionList) {
      const recorded = confirmationTargetOf(revision);
      if (recorded !== null && sameTarget(recorded, target)) return true;
    }
    return false;
  }

  /**
   * 写入一条明示变更后的节点行；新节点插入，已有节点按 ID 替换事务内版本。
   * @param node 变更后的完整节点行，内部复制，调用方后续修改不影响事务
   */
  writeNode(node: CognitionNode): void {
    this.assertActive();
    if (!this.nodeBefore.has(node.id)) {
      this.nodeBefore.set(node.id, readNodeFromIndex(this.base.nodes, node.id));
      this.nodeOrder.push(node.id);
    }
    this.nodeAfter.set(node.id, cloneNode(node));
  }

  /**
   * 写入一条新引用；引用只增不改，重复 ID 报 invalid 并回滚。
   * @param ref 新引用，内部复制
   * @throws CognitionError 引用 ID 已存在（invalid）
   */
  writeRef(ref: Ref): void {
    this.assertActive();
    if (this.base.refs.has(ref.id) || this.refIds.has(ref.id)) {
      throw new CognitionError('invalid', `引用 ${ref.id} 已存在，引用只增不改`);
    }
    const copy = cloneRef(ref);
    this.refList.push(copy);
    this.refIds.add(copy.id);
  }

  /**
   * 追加一条修订；修订只追加，重复 ID 报 invalid 并回滚。
   * @param revision 新修订，内部复制
   * @throws CognitionError 修订 ID 已存在（invalid）
   */
  appendRevision(revision: Revision): void {
    this.assertActive();
    if (this.base.revisions.has(revision.id) || this.revisionIds.has(revision.id)) {
      throw new CognitionError('invalid', `修订 ${revision.id} 已存在，修订只追加`);
    }
    const copy = cloneRevision(revision);
    this.revisionList.push(copy);
    this.revisionIds.add(copy.id);
  }

  /**
   * 结束 work 后使句柄失效；无论成功或抛错都调用，提交段不再接受任何写入。
   */
  markFinished(): void {
    this.active = false;
  }

  /**
   * 取本次写入的节点前后行，供提交时更新父子索引与未确认索引。
   * @returns 按首次写入顺序排列的节点变更
   */
  changes(): NodeChange[] {
    const changes: NodeChange[] = [];
    for (const nodeId of this.nodeOrder) {
      const before = this.nodeBefore.get(nodeId) ?? null;
      const after = this.nodeAfter.get(nodeId);
      if (after !== undefined) changes.push({ id: nodeId, before, after });
    }
    return changes;
  }

  /**
   * 取本次追加的引用。
   * @returns 按写入顺序排列的引用
   */
  refs(): readonly Ref[] {
    return this.refList;
  }

  /**
   * 取本次追加的修订。
   * @returns 按写入顺序排列的修订
   */
  revisions(): readonly Revision[] {
    return this.revisionList;
  }

  /**
   * 取提交后某节点的行；供未确认索引重算未改动的指针节点。
   * @param nodeId 节点 ID
   * @returns 事务内行或已提交行；不存在时为 null
   */
  getNode(nodeId: NodeId): CognitionNode | null {
    const pending = this.nodeAfter.get(nodeId);
    return pending !== undefined ? pending : readNodeFromIndex(this.base.nodes, nodeId);
  }

  /**
   * 取事务内可见的修订；供未确认索引读取形成记录的 at/by/summary。
   * @param revisionId 修订 ID
   * @returns 修订或 null
   */
  getRevision(revisionId: RevisionId): Revision | null {
    const pending = this.revisionList.find((revision) => revision.id === revisionId);
    return pending !== undefined ? pending : this.base.revisions.current(revisionId);
  }

  /**
   * 取本次写入后的节点行，按首次写入顺序。
   * @returns 已由事务拥有的节点行数组
   */
  nodesAfter(): CognitionNode[] {
    return this.nodeOrder
      .map((nodeId) => this.nodeAfter.get(nodeId))
      .filter((node): node is CognitionNode => node !== undefined);
  }
}
