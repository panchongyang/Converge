/**
 * 内存存储的只读快照（接口单 3.3 的 ReadSnapshot 端口）。
 *
 * 职责：固定提交版本，按 ID、父节点、引用两端、时间键与未确认索引分批读取；
 * 所有方法只读打开时捕获的节点映射根、修订表版本与索引根，之后的新提交与本次读取隔离。
 * 边界：返回副本，调用方修改结果不影响存储或其他快照；不做遍历、去重或预算投影。
 * 协作：store.openRead 捕获来源；queries 在快照上按稳定键推进分页；
 * close 后主动清空来源引用并拒绝再读，旧索引根与旧节点根不再被本快照持有。
 */
import type {
  CognitionNode,
  ConfirmTarget,
  NodeId,
  NodeRow,
  PendingTarget,
  ReadSnapshot,
  Ref,
  RefId,
  Revision,
  RevisionActor,
  RevisionId,
} from '../../types';
import { CognitionError } from '../../types';
import { cloneNode, cloneOrigin, cloneRef, cloneRevision } from './clone';
import type { IndexRoots } from './indexes';
import {
  compareTimeKeys,
  MAX_KEY_PART,
  revisionTimeKey,
  type ChildKey,
  type ImportKey,
  type NodeRevisionKey,
  type RefKey,
  type TimeKey,
} from './keys';
import { readNodeFromIndex, type NodeIndex } from './node-table';
import type { OrderedEntry } from './ordered-map';
import type { RevisionTable } from './revision-table';
import {
  pendingFormationTarget,
  pendingImportTarget,
  type PendingFormationRecord,
  type UnconfirmedRoots,
} from './unconfirmed';

/** 打开快照时捕获的数据来源；快照关闭时整体置空。 */
export interface SnapshotSource {
  /** 打开时的已提交版本。 */
  readonly version: number;
  /** 打开时的树根。 */
  readonly rootId: NodeId;
  /** 打开时的节点映射根；旧根只被快照持有。 */
  readonly nodes: NodeIndex;
  /** 修订表；按 version 过滤打开之后写入的记录。 */
  readonly revisions: RevisionTable;
  /** 打开时的排序索引根。 */
  readonly indexes: IndexRoots;
  /** 打开时的未确认索引根。 */
  readonly unconfirmed: UnconfirmedRoots;
}

/**
 * 把分页额度收敛成非负整数；非法值按 0 处理，便于调用方安全地“不取”。
 * @param limit 调用方传入的本批最多行数
 * @returns 实际可取的条数
 */
function takeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

/**
 * 把完整节点投影成不含正文的轻行，保留省略键表示手稿未载。
 * @param node 已保存节点
 * @returns 遍历与绘制需要的轻行
 */
function rowOf(node: CognitionNode): NodeRow {
  const row: NodeRow = {
    id: node.id,
    parentId: node.parentId,
    title: node.body.title,
    origin: cloneOrigin(node.origin),
  };
  if (node.state !== undefined) row.state = node.state;
  if (node.currentChange !== undefined) row.currentChange = { ...node.currentChange };
  if (node.confirmation !== undefined) row.confirmation = node.confirmation;
  return row;
}

/** 内存存储的只读快照；close 幂等，关闭后再读视为调用方错误。 */
export class MemoryReadSnapshot implements ReadSnapshot {
  readonly stamp: number;
  readonly rootId: NodeId;
  private source: SnapshotSource | null;

  /**
   * 用 store 捕获的已提交来源创建快照。
   * @param source 固定版本的节点根、修订表与索引根
   */
  constructor(source: SnapshotSource) {
    this.stamp = source.version;
    this.rootId = source.rootId;
    this.source = source;
  }

  /**
   * 取出仍有效的来源；关闭后读取属于调用方错误。
   * @returns 打开时捕获的来源
   * @throws Error 快照已关闭
   */
  private requireSource(): SnapshotSource {
    if (this.source === null) throw new Error('ReadSnapshot 已关闭，不能继续读取');
    return this.source;
  }

  /**
   * 按 ID 读完整节点行。
   * @param nodeId 目标节点
   * @returns 节点副本；该版本不存在时为 null
   */
  async readNode(nodeId: NodeId): Promise<CognitionNode | null> {
    const source = this.requireSource();
    const node = readNodeFromIndex(source.nodes, nodeId);
    return node === null ? null : cloneNode(node);
  }

  /**
   * 按 ID 读轻行投影。
   * @param nodeId 目标节点
   * @returns 轻行；该版本不存在时为 null
   */
  async readNodeRow(nodeId: NodeId): Promise<NodeRow | null> {
    const source = this.requireSource();
    const node = readNodeFromIndex(source.nodes, nodeId);
    return node === null ? null : rowOf(node);
  }

  /**
   * 按 ID 读修订全文。
   * @param revisionId 目标修订
   * @returns 修订副本；该版本尚未写入时为 null
   */
  async readRevision(revisionId: RevisionId): Promise<Revision | null> {
    const source = this.requireSource();
    const revision = source.revisions.readAt(revisionId, source.version);
    return revision === null ? null : cloneRevision(revision);
  }

  /**
   * 按父节点读直接孩子轻行，按稳定 ID 顺序推进。
   * @param parentId 父节点 ID
   * @param after 上一批末行 ID；null 从头开始
   * @param limit 本批最多返回行数
   * @returns 本批轻行，可能为空
   */
  async listChildren(parentId: NodeId, after: NodeId | null, limit: number): Promise<NodeRow[]> {
    const source = this.requireSource();
    const take = takeLimit(limit);
    if (take === 0) return [];
    const start: ChildKey = [parentId, after ?? ''];
    const result: NodeRow[] = [];
    for (const entry of source.indexes.children.entriesFrom(start, after === null)) {
      if (entry.key[0] !== parentId) break;
      const node = readNodeFromIndex(source.nodes, entry.value);
      if (node !== null) {
        result.push(rowOf(node));
        if (result.length >= take) break;
      }
    }
    return result;
  }

  /**
   * 按起点读出发引用，按引用 ID 顺序推进。
   * @param nodeId 起点节点 ID
   * @param after 上一批末条引用 ID；null 从头开始
   * @param limit 本批最多返回条数
   * @returns 本批引用副本，可能为空
   */
  async listRefsFrom(nodeId: NodeId, after: RefId | null, limit: number): Promise<Ref[]> {
    const source = this.requireSource();
    const take = takeLimit(limit);
    if (take === 0) return [];
    const start: RefKey = [nodeId, after ?? ''];
    const result: Ref[] = [];
    for (const entry of source.indexes.refsFrom.entriesFrom(start, after === null)) {
      if (entry.key[0] !== nodeId) break;
      result.push(cloneRef(entry.value));
      if (result.length >= take) break;
    }
    return result;
  }

  /**
   * 按树内目标读入向引用，保留原方向，按引用 ID 顺序推进；外部材料不进本索引。
   * @param nodeId 目标节点 ID
   * @param after 上一批末条引用 ID；null 从头开始
   * @param limit 本批最多返回条数
   * @returns 本批引用副本，可能为空
   */
  async listRefsTo(nodeId: NodeId, after: RefId | null, limit: number): Promise<Ref[]> {
    const source = this.requireSource();
    const take = takeLimit(limit);
    if (take === 0) return [];
    const start: RefKey = [nodeId, after ?? ''];
    const result: Ref[] = [];
    for (const entry of source.indexes.refsTo.entriesFrom(start, after === null)) {
      if (entry.key[0] !== nodeId) break;
      result.push(cloneRef(entry.value));
      if (result.length >= take) break;
    }
    return result;
  }

  /**
   * 按时间键读修订：树时间线或指定节点的历史，均从新到旧。
   * @param nodeId 只看该节点历史；null 查整棵树
   * @param after 上一批末条修订 ID；null 从最新开始
   * @param limit 本批最多返回条数
   * @returns 本批修订副本，可能为空
   * @throws CognitionError 续读键在该快照版本中不存在（invalid）
   */
  async listRevisions(
    nodeId: NodeId | null,
    after: RevisionId | null,
    limit: number,
  ): Promise<Revision[]> {
    const source = this.requireSource();
    const take = takeLimit(limit);
    if (take === 0) return [];
    const result: Revision[] = [];

    if (nodeId === null) {
      let before: TimeKey | null = null;
      if (after !== null) {
        const cursor = source.revisions.readAt(after, source.version);
        if (cursor === null) {
          throw new CognitionError('invalid', `时间线续读键 ${after} 在该快照中不存在`);
        }
        before = revisionTimeKey(cursor.at, cursor.id);
      }
      for (const entry of source.indexes.revisionsByTime.entriesBefore(before)) {
        result.push(cloneRevision(entry.value));
        if (result.length >= take) break;
      }
      return result;
    }

    let before: NodeRevisionKey;
    if (after === null) {
      before = [nodeId, MAX_KEY_PART, MAX_KEY_PART];
    } else {
      const cursor = source.revisions.readAt(after, source.version);
      if (cursor === null) {
        throw new CognitionError('invalid', `节点历史续读键 ${after} 在该快照中不存在`);
      }
      before = [nodeId, revisionTimeKey(cursor.at, cursor.id)[0], cursor.id];
    }
    for (const entry of source.indexes.revisionsByNode.entriesBefore(before)) {
      if (entry.key[0] !== nodeId) break;
      result.push(cloneRevision(entry.value));
      if (result.length >= take) break;
    }
    return result;
  }

  /**
   * 按未确认索引分批读待确认目标。形成记录按 (at, 修订 ID) 从新到旧，
   * 两种执行者合并排序；导入判断随后按节点 ID 升序。不扫描全树、不做全量计数。
   * @param by 执行者种类的非空子集：human / ai 筛形成记录，import 选导入判断
   * @param after 上一页末项对应的确认目标；null 从第一项开始
   * @param limit 本批最多返回项数
   * @returns 本批待确认目标，可能为空
   * @throws CognitionError 游标修订不存在或不是形成记录（invalid）
   */
  async listUnconfirmed(
    by: RevisionActor[],
    after: ConfirmTarget | null,
    limit: number,
  ): Promise<PendingTarget[]> {
    const source = this.requireSource();
    const take = takeLimit(limit);
    if (take === 0) return [];
    const selected = new Set(by);

    let formationBefore: TimeKey | null = null;
    let includeFormations = true;
    let importAfter: NodeId | null = null;
    if (after !== null) {
      const revisionId = after.revisionId;
      if (revisionId !== undefined) {
        const cursor = source.revisions.readAt(revisionId, source.version);
        if (cursor === null || cursor.kind !== 'formation' || cursor.by === 'import') {
          throw new CognitionError('invalid', `未确认分页游标 ${revisionId} 在该快照中不存在`);
        }
        formationBefore = revisionTimeKey(cursor.at, cursor.id);
      } else if (after.seedNodeId !== undefined) {
        // 导入判断排在全部形成记录之后；以它为游标时不再回头列形成记录。
        includeFormations = false;
        importAfter = after.seedNodeId;
      } else {
        throw new CognitionError('invalid', '未确认分页游标既不是修订也不是导入判断');
      }
    }

    const result: PendingTarget[] = [];
    if (includeFormations) {
      const iterators: Array<
        IterableIterator<OrderedEntry<TimeKey, PendingFormationRecord>>
      > = [];
      if (selected.has('human')) {
        iterators.push(source.unconfirmed.human.entriesBefore(formationBefore));
      }
      if (selected.has('ai')) {
        iterators.push(source.unconfirmed.ai.entriesBefore(formationBefore));
      }
      const current = iterators.map((iterator) => iterator.next());
      while (result.length < take) {
        let best = -1;
        for (let index = 0; index < current.length; index += 1) {
          const item = current[index];
          if (item === undefined || item.done) continue;
          const bestItem = best < 0 ? undefined : current[best];
          if (
            bestItem === undefined ||
            bestItem.done ||
            compareTimeKeys(item.value.key, bestItem.value.key) > 0
          ) {
            best = index;
          }
        }
        const chosen = best < 0 ? undefined : current[best];
        if (chosen === undefined || chosen.done) break;
        result.push(pendingFormationTarget(chosen.value.value));
        const iterator = iterators[best];
        if (iterator !== undefined) current[best] = iterator.next();
      }
    }

    if (selected.has('import') && result.length < take) {
      const start: ImportKey = [importAfter ?? ''];
      for (const entry of source.unconfirmed.imports.entriesFrom(start, importAfter === null)) {
        result.push(pendingImportTarget(entry.value));
        if (result.length >= take) break;
      }
    }
    return result;
  }

  /**
   * 释放快照；重复调用无副作用。关闭后清空对节点根、索引根与修订表的引用，
   * 让不再被其他快照持有的旧版本可被运行时回收。
   * @returns 释放完成的 Promise
   */
  async close(): Promise<void> {
    this.source = null;
  }
}
