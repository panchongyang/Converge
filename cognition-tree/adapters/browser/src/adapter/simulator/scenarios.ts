/**
 * AI 模拟器的预设场景：针对样例 T1，以 AI 身份制造提议与日常变更。
 *
 * 覆盖正式操作目录下 AI 能做的事（addBranch、decideNode）、需要人确认的事（confirm），
 * 以及两种会被内核拒绝的输入（依赖前提指向祖先、AI 越权确认）。场景只经 AiCaller 调用；
 * 结果（保存或拒绝）由内核规则决定，这里不预判，只标注期望以便开发坞区分。
 *
 * 文案是模拟的 AI 输入，写进浏览器测试存储；不是正式认知数据，也不是 DSH 工具的真实调用。
 */
import type { OpInput } from '@cognition-tree/kernel/catalog/contracts';
import type { Decision, Draft, NodeId, Placement, TreeId } from '@cognition-tree/kernel/types';
import type { AiCaller } from '../env';

export interface ScenarioResult {
  /** 结果说明，显示在开发坞的记录里。 */
  detail: string;
  /** 新提议或受影响的节点；被拒绝时没有。 */
  nodeId?: NodeId;
}

export interface Scenario {
  id: string;
  /** 卡片上的动作类型。 */
  kind: string;
  title: string;
  description: string;
  /** accepted：应当被保存为 AI 执行；rejected：应当被内核拒绝。 */
  expect: 'accepted' | 'rejected';
  run(ai: AiCaller, treeId: TreeId, selectedId: NodeId | null): Promise<ScenarioResult>;
}

/**
 * 生成一个“AI 新增分支”的场景。
 * @param placement 落点
 * @param draft 新判断
 */
function propose(placement: Placement, draft: Draft) {
  return async (ai: AiCaller, treeId: TreeId): Promise<ScenarioResult> => {
    const input: OpInput['addBranch'] = { treeId, placement, draft };
    const nodeId = await ai.call('addBranch', input);
    return { nodeId, detail: '已保存为「AI 执行 · 未确认」：' + nodeId };
  };
}

/**
 * 生成一个“AI 执行日常决定”的场景。
 * @param nodeId 被操作的判断
 * @param decision 决定
 */
function decide(nodeId: NodeId, decision: Decision) {
  return async (ai: AiCaller, treeId: TreeId): Promise<ScenarioResult> => {
    const input: OpInput['decideNode'] = { treeId, nodeId, decision };
    const out = await ai.call('decideNode', input);
    return { nodeId: out, detail: '已保存为「AI 执行 · 未确认」：' + out };
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'supplement-concept',
    kind: '补充',
    title: '补充 T1.2.4：概念先作引用目标',
    description: '在未决的“概念单独成层”下补一条子分支，引用术语表。',
    expect: 'accepted',
    run: propose(
      { parentId: 'T1.2.4', kind: 'supplement' },
      {
        body: {
          title: '概念先作为引用目标，不另起一棵树',
          basis: '查名词类分支产出的是定义；让判断节点用引用指向定义，就不必先设计概念层自己的结构。',
        },
        state: 'open',
        refs: [{ kind: 'example', target: { doc: 'cognition-tree/docs/glossary.md' } }],
      },
    ),
  },
  {
    id: 'erratum-pure-tree',
    kind: '勘误',
    title: '勘误 T1.3.1：补记缺失的复活条件',
    description: '纯树的剪除只有理由、没有复活条件。AI 提出补记，原话不改。',
    expect: 'accepted',
    run: propose(
      { parentId: 'T1.3.1', kind: 'erratum' },
      {
        body: {
          title: '纯树的剪除缺少复活条件，建议补记',
          text: '原记录只写了剪除理由。可补：若实际维护中几乎不出现跨分支的前提、实例或冲突，纯树就够用。',
        },
        state: 'open',
        refs: [{ kind: 'premise', target: { nodeId: 'T1.2.2' } }],
      },
    ),
  },
  {
    id: 'replace-process',
    kind: '替代',
    title: '替代 T1.2.3：把“人确认”另记一类',
    description: '与旧判断同级的替代提议；人须比较后明确接受（会剪去旧判断）或剪去它。',
    expect: 'accepted',
    run: propose(
      { replacesId: 'T1.2.3' },
      {
        body: {
          title: '过程只把改变树形状的事件记为形成；单纯确认另记为「人确认」',
          basis: '只记形状变化时，“AI 执行 → 人确认”这一步没有落点；把确认另记一类，既不退回对话流水账，也能回查谁在何时确认。',
        },
        state: 'keep',
        refs: [{ kind: 'premise', target: { nodeId: 'T1.2.5' } }],
      },
    ),
  },
  {
    id: 'branch-reading',
    kind: '新分支',
    title: '新分支 T1.3.3.2：主阅读方式',
    description: '在“存储与展示分离”下长出一个未决判断，引用待决问题 Q5。',
    expect: 'accepted',
    run: propose(
      { parentId: 'T1.3.3.2', kind: 'branch' },
      {
        body: {
          title: '展示以“从当前问题展开的空间”为主，大纲辅助',
          basis: '空间保留位置记忆，让推导链与跨边一眼可见；大纲保证逐条阅读与键盘操作。两者读同一份视图投影。',
        },
        state: 'open',
        refs: [
          { kind: 'example', target: { doc: 'cognition-tree/docs/open-questions.md', part: 'Q5' } },
          { kind: 'premise', target: { nodeId: 'T1.1', part: 'pruneReason' } },
        ],
      },
    ),
  },
  {
    id: 'pruned-multiparent',
    kind: '剪 · AI 提出',
    title: '新分支 T1.3（剪）：多父节点',
    description: 'AI 提出并建议剪去的判断：显示为“剪 · AI 执行”，人可确认剪除或重新启用。',
    expect: 'accepted',
    run: propose(
      { parentId: 'T1.3', kind: 'branch' },
      {
        body: { title: '允许一个判断有多个父节点', basis: '共享前提可以直接表达成多个父节点。' },
        state: 'prune',
        pruneReason: '多个父节点等于一个判断有多条来路，复述时又要先选路径，回到了通用图的问题；共享前提已由“依赖前提”引用表达。',
        reviveWhen: '出现大量无法用引用表达、必须同时属于两条推导链的判断。',
        refs: [{ kind: 'premise', target: { nodeId: 'T1.3.2', part: 'pruneReason' } }],
      },
    ),
  },
  {
    id: 'ai-prune',
    kind: '日常变更',
    title: 'AI 剪除 T1.2.4',
    description: 'AI 不需要等待人批准就能剪除，并写下理由与复活条件；人仍可确认这次剪除。',
    expect: 'accepted',
    run: decide('T1.2.4', {
      type: 'prune',
      reason: '概念层先放着：等真正出现需要复用的定义，再决定它是不是单独一层。',
      reviveWhen: '出现多个分支反复引用同一份定义、且放在判断正文里已经开始重复。',
    }),
  },
  {
    id: 'ai-revive',
    kind: '日常变更',
    title: 'AI 重新启用 T1.3.2',
    description: 'AI 可以把已剪的判断恢复为未决，理由只写日志，不改正文与旧剪除记录。',
    expect: 'accepted',
    run: decide('T1.3.2', {
      type: 'revive',
      state: 'open',
      reason: '引用边开始变多，通用图与树骨架的取舍值得重新检查。',
    }),
  },
  {
    id: 'invalid-premise',
    kind: '应被拒绝',
    title: '错误示范：依赖前提指向祖先',
    description: '在 T1.3.3.1 下提出新判断，却把它的祖先 T1.3.3 写成“依赖前提”。祖先链本身就是推导依据。',
    expect: 'rejected',
    run: propose(
      { parentId: 'T1.3.3.1', kind: 'branch' },
      {
        body: { title: '引用类型新增“时间先后”' },
        state: 'open',
        refs: [{ kind: 'premise', target: { nodeId: 'T1.3.3' } }],
      },
    ),
  },
  {
    id: 'overreach-confirm',
    kind: '应被拒绝',
    title: '越权：AI 试图“人确认”',
    description: '以 AI 身份对导入的判断 T1.2.4 调用 confirm。确认只能来自人的入口。',
    expect: 'rejected',
    async run(ai, treeId) {
      const input: OpInput['confirm'] = { treeId, target: { seedNodeId: 'T1.2.4' } };
      await ai.call('confirm', input);
      return { detail: '内核接受了 AI 的确认请求（不应发生）' };
    },
  },
];
