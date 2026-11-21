/**
 * 内存存储的单树已提交状态。
 *
 * 职责：把一棵树的提交版本、根、节点表、引用表、修订表、排序索引与未确认索引放在一起；
 * 写事务与读快照都从这份记录取当前事实，事务的改动在发布前不进入这些字段。
 * 边界：不实现事务、不读配置；rootId 在树创建提交前为 null。
 * 协作：store 创建并持有记录；transaction 只读它；commit 在校验与 beforeCommit 成功后
 * 才追加表、替换索引根并推进版本。
 */
import type { NodeId } from '../../types';
import { createIndexRoots, type IndexRoots } from './indexes';
import { createNodeIndex, type NodeIndex } from './node-table';
import { RefTable } from './ref-table';
import { RevisionTable } from './revision-table';
import { UnconfirmedState } from './unconfirmed';

/** 一棵树当前已提交的全部事实与索引。 */
export interface TreeRecord {
  /** 最近一次成功提交的版本；第一次提交后为 1。 */
  stamp: number;
  /** 当前树根；createNew 事务发布前为 null。 */
  rootId: NodeId | null;
  /** 节点索引根；每次提交整体替换，旧根供已打开的读快照持有。 */
  nodes: NodeIndex;
  /** 引用表，用于引用 ID 查重。 */
  readonly refs: RefTable;
  /** 修订表，按 ID 与版本取记录。 */
  readonly revisions: RevisionTable;
  /** 当前排序索引根；每次提交整体替换。 */
  indexes: IndexRoots;
  /** 未确认索引的当前状态；快照捕获其 roots。 */
  readonly unconfirmed: UnconfirmedState;
  /** 已确认目标的去重键集合，只在写事务查重。 */
  readonly confirmedTargets: Set<string>;
}

/**
 * 创建一棵空树的记录；用于 createNew 事务的工作底，提交成功才登记到 store。
 * @returns 版本 0、无根、空表与空索引的记录
 */
export function createTreeRecord(): TreeRecord {
  return {
    stamp: 0,
    rootId: null,
    nodes: createNodeIndex(),
    refs: new RefTable(),
    revisions: new RevisionTable(),
    indexes: createIndexRoots(),
    unconfirmed: new UnconfirmedState(),
    confirmedTargets: new Set<string>(),
  };
}
