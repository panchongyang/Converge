/**
 * UI 纯逻辑测试的样例工厂：只构造契约形状，不读写真实树、不启浏览器。
 */
import type {
  Boundary,
  CognitionNode,
  ConfirmTarget,
  FormationRevision,
  NodeDetail,
  PendingPage,
  PendingTarget,
  TreeView,
  ViewNode,
} from '../src/types/kernel';

/** 一个最小节点。 */
export function node(id: string, overrides: Partial<CognitionNode> = {}): CognitionNode {
  return { id, parentId: null, body: { title: id }, origin: { kind: 'branch' }, ...overrides };
}

/** 一个视图行。 */
export function viewNode(id: string, overrides: Partial<ViewNode> = {}): ViewNode {
  return { id, parentId: null, title: id, origin: { kind: 'branch' }, role: 'hit', ...overrides };
}

/** 一页 readView 结果。 */
export function view(overrides: Partial<TreeView> = {}): TreeView {
  return { rootId: 'T1', focusId: 'T1', nodes: [viewNode('T1')], refs: [], boundaries: [], complete: true, stamp: 1, ...overrides };
}

/** 一条新写形成记录。 */
export function formation(id: string, overrides: Partial<FormationRevision> = {}): FormationRevision {
  return {
    id,
    kind: 'formation',
    at: '2026-11-20T10:00:00+08:00',
    by: 'ai',
    nodeIds: ['T1.1'],
    summary: 'AI 提出一个新判断',
    detail: { action: 'addBranch', effects: [{ nodeId: 'T1.1', afterState: 'keep' }] },
    ...overrides,
  };
}

/** readNode 的结果。 */
export function detail(nodeValue: CognitionNode, currentChange?: FormationRevision): NodeDetail {
  return currentChange ? { node: nodeValue, currentChange } : { node: nodeValue };
}

/** 一条边界。 */
export function boundary(nodeId: string, axis: Boundary['axis'], kind: Boundary['kind']): Boundary {
  return { nodeId, axis, kind };
}

/** 一条形成记录待确认项。 */
export function revisionPending(
  revisionId: string,
  nodeIds: string[],
  by: 'ai' | 'human' = 'ai',
): PendingTarget {
  return {
    revisionId,
    at: '2026-11-20T10:00:00+08:00',
    by,
    summary: '待确认的变更',
    nodeIds,
  };
}

/** 一条导入判断待确认项。 */
export function seedPending(seedNodeId: string, title = '导入判断'): PendingTarget {
  return { seedNodeId, title };
}

/** 一页待确认。 */
export function pendingPage(items: PendingTarget[], next?: ConfirmTarget): PendingPage {
  return next ? { items, next } : { items };
}
