/**
 * 样例数据：手稿 T1（仓库根《认知树.md》）的转写，形状是正式内核的 SeedTree。
 *
 * 性质：浏览器测试存储里的一次性样例导入，用于走通产品流程；不是 Q4 的正式自举，
 * 也不是产品树。节点沿用原 ID；分支状态、确认程度、剪除理由、复活条件与正文按手稿
 * 原样转写，手稿缺项（T1.3.1 的复活条件、T1.3 的分支状态与确认来源）保持缺失。
 *
 * 历史按“形成记录”原行序；同一行既有形成又有确认时拆成两条，共用原出处。
 * 手稿只有日期，`at` 就写日期，不补午夜或导入时刻，也不给导入事实补造结构化明细。
 *
 * 正式 Ref 没有 note / label 字段：手稿引用后的括注和外部材料显示名保留在每条引用旁的
 * 注释里，不因为类型不支持而消失；运行时只按 doc / part / 类型与方向显示。
 */
import type { SeedHistoryEntry, SeedNode, SeedTree, Ref } from '@cognition-tree/kernel/types';

const NOTE_8 = '由 AI 提出；确认依据见形成记录 #8';
const DAY = '2026-11-19';

/**
 * 生成一个普通分支种子节点。
 * @param id 手稿里的稳定 ID
 * @param parentId 手稿概览中的真实父节点
 * @param rest 正文、状态、确认程度及剪除信息
 * @returns 种子节点；origin 固定为普通分支
 */
function node(
  id: string,
  parentId: string | null,
  rest: Omit<SeedNode, 'id' | 'parentId' | 'origin'>,
): SeedNode {
  return { id, parentId, origin: { kind: 'branch' }, ...rest };
}

const nodes: SeedNode[] = [
  node('T1', null, {
    body: {
      title: '共同认知用什么结构表达？',
      source: '2026-11-19，讨论一个树形组织对话的产品对 Converge 的启发。',
      note: '根问题，持续生长',
    },
    state: 'open',
  }),
  node('T1.1', 'T1', {
    body: { title: '对话树：按对话过程组织', note: '人类以 T1.2 的表述接受了这一点' },
    state: 'prune',
    confirmation: 'humanConfirmed',
    pruneReason:
      '保存的是过程，不是认知；树的组织和导航负担落在人身上。查名词这类分支通常已经闭合，没必要作为结构长期保留；而质疑类分支如果不回流主线，会造成虚假对齐（[idea3](idea3.md)）。',
    reviveWhen: '研究目标变成复盘对话过程本身。',
  }),
  node('T1.2', 'T1', {
    body: {
      title: '决策树：节点是判断，不是发言',
      basis: '与 [共同认知与重现](共同认知与重现.md) §2 的保存清单一一对应。',
      note: '由人类提出的归纳',
    },
    state: 'keep',
    confirmation: 'humanConfirmed',
  }),
  node('T1.2.1', 'T1.2', {
    body: {
      title: '长出和剪掉的分支都诚实记录，并管理树的形成过程',
      note: '人提出如实记录新增、剪除的分支和树的形成过程（转述）',
    },
    state: 'keep',
    confirmation: 'humanConfirmed',
  }),
  node('T1.2.2', 'T1.2', {
    body: {
      title: '剪枝记录理由及成立条件',
      basis: '剪枝是否成立，取决于当时的条件；只记“剪了”，条件变化后就没人知道该重新考虑。',
      note: NOTE_8,
    },
    state: 'keep',
    confirmation: 'humanConfirmed',
  }),
  node('T1.2.3', 'T1.2', {
    body: {
      title: '过程只记录改变树形状的事件',
      basis: '记录每一次讨论，就退回了对话树（T1.1）。值得记录的只有长出、剪除、反转和重新启用。',
      note: NOTE_8,
    },
    state: 'keep',
    confirmation: 'humanConfirmed',
  }),
  node('T1.2.4', 'T1.2', {
    body: {
      title: '概念单独成层，由决策节点引用',
      basis: '查名词类的分支产出的是概念定义，不是决策；混进决策树会让结构变乱。',
      openReason: '尚未讨论概念层的结构，以及它与决策树的关系。',
    },
    state: 'open',
    confirmation: 'unconfirmed',
  }),
  node('T1.2.5', 'T1.2', {
    body: { title: '结构由 AI 提议维护，人确认或纠正', note: NOTE_8 },
    state: 'keep',
    confirmation: 'humanConfirmed',
  }),
  node('T1.3', 'T1', {
    body: {
      title: '结构形态：树还是图？',
      source: '人类提出“可能实际上是图”，并追问图是不是必要的结构。',
      note: '已有结论（见 T1.3.3）',
    },
  }),
  node('T1.3.1', 'T1.3', {
    body: {
      title: '纯树',
      basis:
        '[认知事件候选集](research/cognition-events-2026-11-15.md) 中，E02 和 E09 共享“项目未发布”这一前提；E05 和 E16 是同一原则的两个实例；E10、E15、E17 是同一失效模式。',
    },
    state: 'prune',
    confirmation: 'humanConfirmed',
    pruneReason: '共享前提、同类实例、与事实冲突这三种关系无法表达；靠复制节点表达，前提失效时容易漏改。',
    // 手稿没有记录复活条件，这里保持缺项，不补造。
  }),
  node('T1.3.2', 'T1.3', {
    body: { title: '通用图', note: '人明确排除通用图（转述）' },
    state: 'prune',
    confirmation: 'humanConfirmed',
    pruneReason: '一个节点有多条来路，阅读和复述时要先选路径；边没有类型会退化成乱线。',
    reviveWhen: '实际维护中引用边的种类多、密度高，树骨架已经失去意义。',
  }),
  node('T1.3.3', 'T1.3', {
    body: {
      title: '树 + 有类型引用边',
      basis: '19 个事件中人工标注了约 5 处跨事件关系，跨边真实存在但较稀疏。',
      note: '人认可树骨架加引用边的结构，而非通用图（转述）',
    },
    state: 'keep',
    confirmation: 'humanConfirmed',
  }),
  node('T1.3.3.1', 'T1.3.3', {
    body: { title: '边类型少而固定，新增类型须说明回答了什么新问题', note: NOTE_8 },
    state: 'keep',
    confirmation: 'humanConfirmed',
  }),
  node('T1.3.3.2', 'T1.3.3', {
    body: {
      title: '存储与展示分离',
      text: '底层存储带类型的边；给人看的是从当前问题展开的树，跨边只作为“另见”或“受影响”提示出现。',
      note: NOTE_8,
    },
    state: 'keep',
    confirmation: 'humanConfirmed',
  }),
  node('T1.3.3.3', 'T1.3.3', {
    body: { title: '用 19 个认知事件做纸面验证', note: '人决定' },
    state: 'prune',
    confirmation: 'humanConfirmed',
    pruneReason: '人类判断讨论已经足以理解，不需要实验。',
    reviveWhen: '实际维护中频繁出现放不进树的关系，或者需要新增引用边类型。',
  }),
];

const refs: Ref[] = [
  {
    // 手稿括注：“项目未发布”时剪掉了两档兼容，并写明“若出现外部 v2 store 再评估”；显示名「认知事件 E02」。
    id: 'ref-T1.2.2-1',
    from: 'T1.2.2',
    kind: 'example',
    target: { doc: 'research/cognition-events-2026-11-15.md', part: 'E02' },
  },
  {
    // 手稿括注：最有价值的是理由和被否方案，不是完整经过；显示名「E02 实验结论」。
    id: 'ref-T1.2.3-1',
    from: 'T1.2.3',
    kind: 'example',
    target: { doc: 'experiments/E02-project-recall/results.md' },
  },
  {
    // 手稿括注：结构负担不应落在人身上。
    id: 'ref-T1.2.5-1',
    from: 'T1.2.5',
    kind: 'premise',
    target: { nodeId: 'T1.1', part: 'pruneReason' },
  },
  {
    // 手稿括注：局部纠偏思路；显示名「idea」。
    id: 'ref-T1.2.5-2',
    from: 'T1.2.5',
    kind: 'example',
    target: { doc: 'idea.md' },
  },
  {
    // 手稿括注：无类型边会退化成乱线。
    id: 'ref-T1.3.3.1-1',
    from: 'T1.3.3.1',
    kind: 'premise',
    target: { nodeId: 'T1.3.2', part: 'pruneReason' },
  },
  {
    id: 'ref-T1.3.3.2-1',
    from: 'T1.3.3.2',
    kind: 'premise',
    target: { nodeId: 'T1.1', part: 'pruneReason' },
  },
  {
    id: 'ref-T1.3.3.2-2',
    from: 'T1.3.3.2',
    kind: 'example',
    target: { nodeId: 'T1.2.5' },
  },
];

/**
 * 生成一条按手稿行转写的导入历史。
 * @param row 手稿“形成记录”的行号，写进原出处
 * @param kind 原记录是形成还是确认
 * @param nodeIds 关联的稳定节点 ID
 * @param summary 原叙述
 */
function entry(
  row: number,
  kind: SeedHistoryEntry['kind'],
  nodeIds: string[],
  summary: string,
): SeedHistoryEntry {
  return {
    kind,
    at: DAY,
    by: 'import',
    nodeIds,
    summary,
    source: '认知树.md 形成记录 #' + row,
  };
}

/**
 * T1 样例种子。
 * @returns 每次调用都返回新对象（JSON 深拷贝），调用方可放心修改，不污染其他实例
 */
export function createT1Seed(): SeedTree {
  const seed: SeedTree = {
    treeId: 'T1',
    rootId: 'T1',
    nodes,
    refs,
    // 手稿同一行既有形成又有确认时拆成两条，共用 source；行序即数组顺序。
    history: [
      entry(1, 'formation', ['T1', 'T1.1'], '人类引入树形对话产品；AI 分析认为它保存的是过程而不是认知 —— 长出 T1；提出剪除 T1.1'),
      entry(2, 'formation', ['T1.2', 'T1.2.1'], '人归纳为决策树，要求如实记录新增和剪除的分支 —— 长出 T1.2、T1.2.1'),
      entry(2, 'confirmation', ['T1.1'], 'T1.1 的剪除得到确认'),
      entry(3, 'formation', ['T1.2.2', 'T1.2.3', 'T1.2.4', 'T1.2.5'], 'AI 补充剪枝条件、过程粒度、概念层、维护分工 —— 长出 T1.2.2–T1.2.5（未确认）'),
      entry(4, 'formation', ['T1.3'], '人提出需比较图与树 —— 长出 T1.3'),
      entry(5, 'formation', ['T1.3.1', 'T1.3.2', 'T1.3.3', 'T1.3.3.1', 'T1.3.3.2', 'T1.3.3.3'], 'AI 分析：树不够，通用图过度 —— 长出 T1.3.1–T1.3.3 及其子节点'),
      entry(6, 'confirmation', ['T1.3.3'], '人确认树骨架加引用边 —— T1.3.3 确认'),
      entry(6, 'formation', ['T1.3.1', 'T1.3.2', 'T1.3.3.3'], '人类判断不需要实验 —— 剪除 T1.3.1、T1.3.2、T1.3.3.3'),
      entry(7, 'formation', ['T1'], '人类要求记录，并以本次讨论自举一棵树 —— 建立 认知树.md 与 认知表达结构.md'),
      entry(8, 'confirmation', ['T1.2.2', 'T1.2.3', 'T1.2.5', 'T1.3.3.1', 'T1.3.3.2'], '人确认列出的五项 AI 提议 —— 由 AI 提出转为人确认；树的拓扑不变，T1.2.4 仍未决'),
    ],
  };
  return JSON.parse(JSON.stringify(seed)) as SeedTree;
}
