/**
 * 内存存储的深拷贝。
 *
 * 职责：把写入口传入的行、宿主回调收到的增量与读快照返回的结果彼此隔离；
 * 调用方之后修改自己持有的对象，不会改到已提交数据或其他快照。
 * 边界：只复制内核契约里的节点、引用、修订与确认目标，不处理任意对象；
 * 不依赖 structuredClone 等宿主 API，保持内核只依赖 ES 标准库。
 * 协作：transaction 在 writeNode/writeRef/appendRevision 时复制输入；
 * snapshot 在返回行、引用、修订时复制输出；提交前的 MemoryDelta 也是独立副本。
 */
import type {
  CognitionNode,
  ConfirmTarget,
  EffectItem,
  FormationDetail,
  ImportedRevision,
  Origin,
  Ref,
  Revision,
  RevisionDetail,
} from '../../types';

/**
 * 复制节点来历；替代来历带旧节点 ID 与执行状态。
 * @param origin 原来历
 * @returns 新的来历对象
 */
export function cloneOrigin(origin: Origin): Origin {
  if (origin.kind === 'replacement') {
    return { kind: 'replacement', replacesId: origin.replacesId, status: origin.status };
  }
  return { kind: origin.kind };
}

/**
 * 复制一个已保存节点，保留“缺键表示手稿未载”的语义。
 * @param node 原节点
 * @returns 新节点；正文、来历与指针都与原对象不共享可变容器
 */
export function cloneNode(node: CognitionNode): CognitionNode {
  const clone: CognitionNode = {
    id: node.id,
    parentId: node.parentId,
    body: { ...node.body },
    origin: cloneOrigin(node.origin),
  };
  if (node.state !== undefined) clone.state = node.state;
  if (node.confirmation !== undefined) clone.confirmation = node.confirmation;
  if (node.currentChange !== undefined) clone.currentChange = { ...node.currentChange };
  if (node.pruneReason !== undefined) clone.pruneReason = node.pruneReason;
  if (node.reviveWhen !== undefined) clone.reviveWhen = node.reviveWhen;
  return clone;
}

/**
 * 复制引用边及其目标定位符。
 * @param ref 原引用
 * @returns 新引用
 */
export function cloneRef(ref: Ref): Ref {
  return {
    id: ref.id,
    from: ref.from,
    kind: ref.kind,
    target: { ...ref.target },
  };
}

/**
 * 复制确认目标。
 * @param target 原目标
 * @returns 新的二选一目标
 */
export function cloneConfirmTarget(target: ConfirmTarget): ConfirmTarget {
  if (target.revisionId !== undefined) return { revisionId: target.revisionId };
  if (target.seedNodeId !== undefined) return { seedNodeId: target.seedNodeId };
  throw new Error('确认目标缺少 revisionId 或 seedNodeId');
}

/**
 * 复制单个状态效果项。
 * @param effect 原效果项
 * @returns 新效果项
 */
function cloneEffect(effect: EffectItem): EffectItem {
  const clone: EffectItem = { nodeId: effect.nodeId, afterState: effect.afterState };
  if (effect.beforeState !== undefined) clone.beforeState = effect.beforeState;
  return clone;
}

/**
 * 复制形成记录明细；各动作的专用字段按判别分支保留。
 * @param detail 原形成明细
 * @returns 新形成明细
 */
function cloneFormationDetail(detail: FormationDetail): FormationDetail {
  const effects = detail.effects.map(cloneEffect);
  switch (detail.action) {
    case 'createTree':
      return { action: 'createTree', effects };
    case 'addBranch':
      return { action: 'addBranch', effects };
    case 'prune':
      return {
        action: 'prune',
        effects,
        reason: detail.reason,
        reviveWhen: detail.reviveWhen,
      };
    case 'revive': {
      const clone: FormationDetail = {
        action: 'revive',
        effects,
        state: detail.state,
        reason: detail.reason,
      };
      if (detail.previousPrune !== undefined) {
        clone.previousPrune = { ...detail.previousPrune };
      }
      return clone;
    }
    case 'setOpenOrKeep':
      return {
        action: 'setOpenOrKeep',
        effects,
        state: detail.state,
        reason: detail.reason,
      };
    case 'applyReplacement':
      return {
        action: 'applyReplacement',
        effects,
        reason: detail.reason,
        reviveWhen: detail.reviveWhen,
        replacement: { ...detail.replacement },
      };
  }
}

/**
 * 复制修订明细；确认明细只复制目标，不复制正文或状态。
 * @param detail 原修订明细
 * @returns 新修订明细
 */
function cloneRevisionDetail(detail: RevisionDetail): RevisionDetail {
  if ('target' in detail) {
    return { target: cloneConfirmTarget(detail.target) };
  }
  return cloneFormationDetail(detail);
}

/**
 * 复制一条修订，保留导入记录可能缺明细的形状。
 * @param revision 原修订
 * @returns 新修订；节点 ID 数组、明细与目标都独立
 */
export function cloneRevision(revision: Revision): Revision {
  const base = {
    id: revision.id,
    at: revision.at,
    nodeIds: revision.nodeIds.slice(),
    summary: revision.summary,
    ...(revision.source === undefined ? {} : { source: revision.source }),
  };
  if (revision.by === 'import') {
    const imported: ImportedRevision = {
      ...base,
      kind: revision.kind,
      by: 'import',
    };
    if (revision.detail !== undefined) imported.detail = cloneRevisionDetail(revision.detail);
    return imported;
  }
  if (revision.kind === 'formation') {
    return {
      ...base,
      kind: 'formation',
      by: revision.by,
      detail: cloneFormationDetail(revision.detail),
    };
  }
  return {
    ...base,
    kind: 'confirmation',
    by: 'human',
    detail: { target: cloneConfirmTarget(revision.detail.target) },
  };
}
