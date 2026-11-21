import { describe, expect, it } from 'vitest';
import type {
  Boundary,
  CognitionNode,
  ConfirmationRevision,
  ConfirmTarget,
  DailyActor,
  Decision,
  EffectItem,
  ErrorCode,
  FormationDetail,
  FormationRevision,
  ImportedRevision,
  NodeDetail,
  NodeId,
  NodeRow,
  PendingTarget,
  Placement,
  ReadSnapshot,
  RefTarget,
  Revision,
  RevisionActor,
  SeedTree,
} from '../src/types';
import { CognitionError } from '../src/types';
import { assertNever } from '../src/utils';

/**
 * 决定种类的穷尽分派：漏掉任何一个 type，tsc 会在 default 的 assertNever 处报错。
 * @param decision 待分派的决定
 * @returns 用于断言的种类标签
 */
function decisionLabel(decision: Decision): string {
  switch (decision.type) {
    case 'prune':
      return `prune:${decision.reason}/${decision.reviveWhen}`;
    case 'revive':
      return `revive:${decision.state}:${decision.reason}`;
    case 'setOpenOrKeep':
      return `setOpenOrKeep:${decision.state}:${decision.reason}`;
    case 'applyReplacement':
      return `applyReplacement:${decision.reason}/${decision.reviveWhen}`;
    default:
      return assertNever(decision);
  }
}

/**
 * 形成记录动作名的穷尽分派：新建树、新增分支与四种决定名都必须处理。
 * @param detail 形成记录明细
 * @returns 用于断言的种类标签
 */
function actionLabel(detail: FormationDetail): string {
  switch (detail.action) {
    case 'createTree':
      return `createTree:${detail.effects.length}`;
    case 'addBranch':
      return `addBranch:${detail.effects.length}`;
    case 'prune':
      return `prune:${detail.reason}/${detail.reviveWhen}`;
    case 'revive':
      return `revive:${detail.state}:${detail.reason}:${detail.previousPrune?.pruneReason ?? '无旧理由'}`;
    case 'setOpenOrKeep':
      return `setOpenOrKeep:${detail.state}:${detail.reason}`;
    case 'applyReplacement':
      return `applyReplacement:${detail.replacement.oldId}->${detail.replacement.newId}`;
    default:
      return assertNever(detail);
  }
}

/**
 * 边界标记的穷尽分派：scope / exhausted / budget 三种都必须处理。
 * @param boundary 读取边界
 * @returns 用于断言的种类标签
 */
function boundaryLabel(boundary: Boundary): string {
  switch (boundary.kind) {
    case 'scope':
      return `scope:${boundary.axis}`;
    case 'exhausted':
      return `exhausted:${boundary.axis}`;
    case 'budget':
      return `budget:${boundary.axis}`;
    default:
      return assertNever(boundary.kind);
  }
}

/**
 * 错误码的穷尽分派：新增错误码时这里必须同步处理。
 * @param code 内核错误码
 * @returns 面向测试的中文标签
 */
function errorCodeLabel(code: ErrorCode): string {
  switch (code) {
    case 'missing':
      return '目标不存在';
    case 'invalid':
      return '输入不合规';
    case 'storage':
      return '存储失败';
    case 'rangeTooLarge':
      return '读取超限';
    case 'viewExpired':
      return '视图过期';
    default:
      return assertNever(code);
  }
}

/** 根节点：手稿载有正文与来历，但不载分支状态与确认程度时省略这两个键。 */
const rootNode: CognitionNode = {
  id: 'T1',
  parentId: null,
  body: { title: '根判断' },
  origin: { kind: 'branch' },
};

/** 与新写形成记录对应的节点详情，供 readNode 的示例。 */
const formation: FormationRevision = {
  id: 'R1',
  kind: 'formation',
  at: '2026-11-20T19:50:09+08:00',
  by: 'ai',
  nodeIds: ['T1'],
  summary: 'AI 补充子判断',
  detail: { action: 'addBranch', effects: [{ nodeId: 'T1', afterState: 'open' }] },
};

/** 人确认记录：确认目标是一条形成记录，不是 currentChange。 */
const confirmation: ConfirmationRevision = {
  id: 'R2',
  kind: 'confirmation',
  at: '2026-11-20T20:00:00+08:00',
  by: 'human',
  nodeIds: ['T1'],
  summary: '人确认这条变更',
  detail: { target: { revisionId: 'R1' } },
};

describe('决定种类穷尽', () => {
  it('四种决定都能被分派且标签正确', () => {
    const decisions: Decision[] = [
      { type: 'prune', reason: '理由', reviveWhen: '条件' },
      { type: 'revive', state: 'keep', reason: '恢复' },
      { type: 'setOpenOrKeep', state: 'open', reason: '改为未决' },
      { type: 'applyReplacement', reason: '替代', reviveWhen: '新条件' },
    ];
    expect(decisions.map(decisionLabel)).toEqual([
      'prune:理由/条件',
      'revive:keep:恢复',
      'setOpenOrKeep:open:改为未决',
      'applyReplacement:替代/新条件',
    ]);
  });

  it('形成记录的六种动作名都能被分派', () => {
    const details: FormationDetail[] = [
      { action: 'createTree', effects: [{ nodeId: 'T1', afterState: 'open' }] },
      { action: 'addBranch', effects: [{ nodeId: 'N1', afterState: 'keep' }] },
      {
        action: 'prune',
        effects: [{ nodeId: 'N1', beforeState: 'keep', afterState: 'prune' }],
        reason: '不成立',
        reviveWhen: '有新依据',
      },
      {
        action: 'revive',
        effects: [{ nodeId: 'N1', beforeState: 'prune', afterState: 'open' }],
        state: 'open',
        reason: '重新考虑',
        previousPrune: { pruneReason: '不成立', reviveWhen: '有新依据' },
      },
      {
        action: 'setOpenOrKeep',
        effects: [{ nodeId: 'N2', beforeState: 'open', afterState: 'keep' }],
        state: 'keep',
        reason: '结论明确',
      },
      {
        action: 'applyReplacement',
        effects: [
          { nodeId: 'N1', beforeState: 'keep', afterState: 'prune' },
          { nodeId: 'N3', beforeState: 'keep', afterState: 'keep' },
        ],
        reason: '替代',
        reviveWhen: '旧依据恢复',
        replacement: { oldId: 'N1', newId: 'N3' },
      },
    ];
    expect(details.map(actionLabel)).toEqual([
      'createTree:1',
      'addBranch:1',
      'prune:不成立/有新依据',
      'revive:open:重新考虑:不成立',
      'setOpenOrKeep:keep:结论明确',
      'applyReplacement:N1->N3',
    ]);
  });
});

describe('形成明细按动作判别', () => {
  it('缺字段或多带决定专用字段都无法通过类型检查', () => {
    // @ts-expect-error prune 必须带复活条件
    const pruneWithoutReviveWhen: FormationDetail = {
      action: 'prune',
      effects: [],
      reason: '不成立',
    };
    // @ts-expect-error 执行替代必须带新旧 ID
    const replacementWithoutIds: FormationDetail = {
      action: 'applyReplacement',
      effects: [],
      reason: '替代',
      reviveWhen: '旧依据恢复',
    };
    // @ts-expect-error revive 必须带明确的目标状态
    const reviveWithoutState: FormationDetail = {
      action: 'revive',
      effects: [],
      reason: '重新考虑',
    };
    // @ts-expect-error addBranch 不得带决定专用字段
    const addBranchWithReason: FormationDetail = {
      action: 'addBranch',
      effects: [],
      reason: '新增分支没有理由参数',
    };
    expect([
      pruneWithoutReviveWhen,
      replacementWithoutIds,
      reviveWithoutState,
      addBranchWithReason,
    ]).toHaveLength(4);
  });
});

describe('边界标记', () => {
  it('scope / exhausted / budget 三种标记都能被穷尽分派', () => {
    const boundaries: Boundary[] = [
      { nodeId: 'T1', axis: 'children', kind: 'scope' },
      { nodeId: 'T1', axis: 'children', kind: 'exhausted' },
      { nodeId: 'T2', axis: 'refs', kind: 'budget' },
    ];
    expect(boundaries.map(boundaryLabel)).toEqual([
      'scope:children',
      'exhausted:children',
      'budget:refs',
    ]);
  });
});

describe('执行者种类', () => {
  it('DailyActor 只含人和 AI，RevisionActor 另含导入', () => {
    const dailyActors: DailyActor[] = ['human', 'ai'];
    const revisionActors: RevisionActor[] = [...dailyActors, 'import'];
    expect(dailyActors).toHaveLength(2);
    expect(revisionActors).toEqual(['human', 'ai', 'import']);
  });

  it('currentChange 只接受日常执行者，导入不能冒充', () => {
    // @ts-expect-error 导入不是日常变更的执行者
    const importedDaily: DailyActor = 'import';
    const importedCurrentChange: CognitionNode = {
      id: 'T2',
      parentId: 'T1',
      body: { title: '导入节点' },
      origin: { kind: 'branch' },
      // @ts-expect-error 导入记录不能成为节点的 currentChange
      currentChange: { revisionId: 'R3', by: 'import' },
    };
    expect(importedDaily).toBe('import');
    expect(importedCurrentChange.currentChange?.by).toBe('import');
  });
});

describe('确认目标二选一', () => {
  it('ConfirmTarget 的两个变体互斥', () => {
    const revisionTarget: ConfirmTarget = { revisionId: 'R1' };
    const seedTarget: ConfirmTarget = { seedNodeId: 'T1' };
    // @ts-expect-error revisionId 与 seedNodeId 不能同时出现
    const bothKeysTarget: ConfirmTarget = { revisionId: 'R1', seedNodeId: 'T1' };
    expect(revisionTarget).toHaveProperty('revisionId');
    expect(seedTarget).toHaveProperty('seedNodeId');
    expect(bothKeysTarget).toHaveProperty('seedNodeId');
  });

  it('PendingTarget 的两个变体互斥，形成记录目标的 by 用 RevisionActor', () => {
    const pendingRevision: PendingTarget = {
      revisionId: 'R1',
      at: '2026-11-20T19:50:09+08:00',
      by: 'ai',
      summary: 'AI 补充子判断',
      nodeIds: ['T1'],
    };
    const pendingSeed: PendingTarget = { seedNodeId: 'T1', title: '导入判断' };
    // @ts-expect-error 形成记录目标不能兼带导入判断的 title
    const mixedPending: PendingTarget = {
      revisionId: 'R1',
      at: '2026-11-20T19:50:09+08:00',
      by: 'ai',
      summary: 'AI 补充子判断',
      nodeIds: ['T1'],
      title: '导入判断',
    };
    // @ts-expect-error 导入判断目标不能兼带形成记录的字段
    const mixedSeed: PendingTarget = {
      seedNodeId: 'T1',
      title: '导入判断',
      at: '2026-11-15',
    };
    expect(pendingRevision).toHaveProperty('revisionId');
    expect(pendingSeed).toHaveProperty('seedNodeId');
    expect(mixedPending).toHaveProperty('title');
    expect(mixedSeed).toHaveProperty('at');
  });

  it('落点与引用目标这两个二选一联合也互斥', () => {
    const placement: Placement = { parentId: 'T1', kind: 'branch' };
    const replacementPlacement: Placement = { replacesId: 'T1' };
    // @ts-expect-error 落点不能同时给父节点与被替代节点
    const ambiguousPlacement: Placement = { parentId: 'T1', kind: 'branch', replacesId: 'T2' };
    const nodeTarget: RefTarget = { nodeId: 'T1', part: 'pruneReason' };
    const docTarget: RefTarget = { doc: 'research/example.md', part: 'E02' };
    // @ts-expect-error 引用目标不能同时指向节点和外部材料
    const ambiguousTarget: RefTarget = { nodeId: 'T1', doc: 'research/example.md' };
    expect(placement).toHaveProperty('parentId');
    expect(replacementPlacement).toHaveProperty('replacesId');
    expect(nodeTarget).toHaveProperty('nodeId');
    expect(docTarget).toHaveProperty('doc');
    expect(ambiguousPlacement).toHaveProperty('replacesId');
    expect(ambiguousTarget).toHaveProperty('doc');
  });
});

describe('修订三分支', () => {
  it('形成、确认、导入三个分支各自可构造', () => {
    const imported: ImportedRevision = {
      id: 'R3',
      kind: 'formation',
      at: '2026-11-15',
      by: 'import',
      nodeIds: ['T1'],
      summary: '从手稿导入根判断',
      source: '认知树.md 形成记录 #1',
    };
    const revisions: Revision[] = [formation, confirmation, imported];
    expect(revisions.map((revision) => revision.by)).toEqual(['ai', 'human', 'import']);
    expect(revisions.map((revision) => revision.kind)).toEqual([
      'formation',
      'confirmation',
      'formation',
    ]);
  });

  it('新写形成记录必须带明细，新写确认只能由人执行', () => {
    // @ts-expect-error 新写的形成记录必须有结构化明细
    const formationWithoutDetail: Revision = {
      id: 'R4',
      kind: 'formation',
      at: '2026-11-20T20:10:00+08:00',
      by: 'ai',
      nodeIds: ['T1'],
      summary: '缺少明细的形成记录',
    };
    // @ts-expect-error 确认记录的执行者只能是 human
    const aiConfirmation: Revision = {
      id: 'R5',
      kind: 'confirmation',
      at: '2026-11-20T20:10:00+08:00',
      by: 'ai',
      nodeIds: ['T1'],
      summary: 'AI 不能获得确认',
      detail: { target: { revisionId: 'R1' } },
    };
    expect(formationWithoutDetail).toHaveProperty('kind', 'formation');
    expect(aiConfirmation).toHaveProperty('by', 'ai');
  });

  it('NodeDetail.currentChange 只能是新写形成记录', () => {
    const detail: NodeDetail = { node: rootNode, currentChange: formation };
    // @ts-expect-error 确认记录不能冒充 currentChange
    const wrongCurrentChange: NodeDetail = { node: rootNode, currentChange: confirmation };
    expect(detail.currentChange?.detail.action).toBe('addBranch');
    expect(wrongCurrentChange.currentChange).toHaveProperty('kind', 'confirmation');
  });
});

describe('缺键与 null 的区别', () => {
  it('手稿未载的状态与确认程度省略键；EffectItem.beforeState 保留接口单的 null', () => {
    const rowWithoutMarks: NodeRow = {
      id: 'T1',
      parentId: null,
      title: '根判断',
      origin: { kind: 'branch' },
    };
    const nodeWithNullState: CognitionNode = {
      id: 'T2',
      parentId: 'T1',
      body: { title: '未载状态' },
      // @ts-expect-error 手稿未载分支状态应省略 state 键，不写 null
      state: null,
      origin: { kind: 'branch' },
    };
    const nodeWithNullConfirmation: CognitionNode = {
      id: 'T3',
      parentId: 'T1',
      body: { title: '未载确认程度' },
      // @ts-expect-error 手稿未载确认程度应省略 confirmation 键，不写 null
      confirmation: null,
      origin: { kind: 'branch' },
    };
    const rowWithNullState: NodeRow = {
      id: 'T4',
      parentId: 'T1',
      title: '未载状态',
      // @ts-expect-error 轻行投影同样用缺键表示手稿未载
      state: null,
      origin: { kind: 'branch' },
    };
    const newEffect: EffectItem = { nodeId: 'T5', afterState: 'keep' };
    const unknownBeforeEffect: EffectItem = {
      nodeId: 'T6',
      beforeState: null,
      afterState: 'prune',
    };
    expect(rootNode.state).toBeUndefined();
    expect(rootNode.confirmation).toBeUndefined();
    expect(rowWithoutMarks.state).toBeUndefined();
    expect(nodeWithNullState).toHaveProperty('state', null);
    expect(nodeWithNullConfirmation).toHaveProperty('confirmation', null);
    expect(rowWithNullState).toHaveProperty('state', null);
    expect(newEffect).not.toHaveProperty('beforeState');
    expect(unknownBeforeEffect.beforeState).toBeNull();
  });
});

describe('种子树', () => {
  it('历史不含内核分配的修订 ID，节点沿用原 ID', () => {
    const seed: SeedTree = {
      treeId: 'T1',
      rootId: 'T1',
      nodes: [
        {
          id: 'T1',
          parentId: null,
          body: { title: '根判断' },
          origin: { kind: 'branch' },
        },
      ],
      refs: [{ id: 'ref-1', from: 'T1', kind: 'premise', target: { nodeId: 'T1' } }],
      history: [
        {
          kind: 'formation',
          at: '2026-11-15',
          by: 'import',
          nodeIds: ['T1'],
          summary: '从手稿导入根判断',
          source: '认知树.md 形成记录 #1',
        },
      ],
    };
    expect(seed.history[0]).not.toHaveProperty('id');
    expect(seed.nodes[0].id).toBe('T1');
    expect(seed.refs[0].id).toBe('ref-1');
  });
});

describe('读快照端口', () => {
  it('快照直接给出树根、完整节点、轻行与按修订 ID 定位的能力', () => {
    // 仅编译期占位：不构造具体适配器，只校验 ReadSnapshot 的签名满足接口单 3.2 / 3.3。
    const checkReadSnapshot = (snapshot: ReadSnapshot): void => {
      const rootId: NodeId = snapshot.rootId;
      const node: Promise<CognitionNode | null> = snapshot.readNode(rootId);
      const row: Promise<NodeRow | null> = snapshot.readNodeRow(rootId);
      const children: Promise<NodeRow[]> = snapshot.listChildren(rootId, null, 10);
      const revision: Promise<Revision | null> = snapshot.readRevision('R1');
      void [node, row, children, revision];
    };
    expect(checkReadSnapshot).toBeTypeOf('function');
  });
});

describe('错误码与 CognitionError', () => {
  it('五个错误码都能被穷尽分派', () => {
    const codes: ErrorCode[] = ['missing', 'invalid', 'storage', 'rangeTooLarge', 'viewExpired'];
    expect(codes.map(errorCodeLabel)).toEqual([
      '目标不存在',
      '输入不合规',
      '存储失败',
      '读取超限',
      '视图过期',
    ]);
  });

  it('CognitionError 保留错误码、名称与面向人的说明', () => {
    const error = new CognitionError('missing', '节点不存在');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CognitionError');
    expect(error.code).toBe('missing');
    expect(error.message).toBe('节点不存在');
  });
});
