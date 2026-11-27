/**
 * AI-only 具名工具；只翻译参数、可信会话与模型正文，不暴露 confirm/bootstrap 或通用 dispatch。
 * schema 使用已安装 DSH 的原始 JSON Schema 子集；业务规则仍在 kernel catalog/commands/queries。
 * description 只给模型读参数含义与单位，不代替内核校验，也不为参数新增业务缺省。
 */
import { CognitionError, type TreeView } from '@cognition-tree/kernel/types';
import type { HostContext, HostTool, JsonSchema } from './abi';
import { AI_TOOLS, type AiOp } from '../../types/wire';
import { AI_READ_VIEW_GUIDE } from '../ai-read-view';
import { renderAiReadView } from '../ai-view-wire';
import { AI_READ_VIEW_BUDGET, exactObject, parseAiInput, record } from './input';
import type { ProcessInput } from '../backend/protocol';
import { boundaryError, type HostRuntime } from './runtime';
import { assertAiWriteAllowed } from './file-policy';

/** 构造严格具名对象；required 没有隐式缺省。@param properties 允许字段。@param required 必传字段。@param description 字段含义。 */
function object(properties: Record<string, JsonSchema>, required = Object.keys(properties), description?: string): JsonSchema & { type: 'object' } {
  return { type: 'object', properties, required, additionalProperties: false, ...(description === undefined ? {} : { description }) };
}
/** 构造明确枚举。@param description 枚举取值含义。@param values 可选字面值。 */
function enumeration(description: string, ...values: string[]): JsonSchema {
  return { type: 'string', enum: values, description };
}
/** 带用途说明的字符串字段；description 不参与执行校验。@param description 字段含义。 */
function stringField(description: string): JsonSchema { return { type: 'string', description }; }
/** 带用途与计数单位的整数字段；description 不参与执行校验。@param description 字段含义。 */
function integerField(description: string): JsonSchema { return { type: 'integer', description }; }

const treeId = stringField('当前工作区中的稳定树标识；创建时由调用方指定，之后不变；读写都按它定位同一棵树。');
const nodeId = stringField('树内判断的稳定节点 ID；从该树已有节点或上次读取结果取得，不按标题猜。');
const expectedStamp = integerField('可选并发检查：用刚读到的当前树 stamp（CTV2 页头的 t），正安全整数。树变化则拒绝，须重新读与判断；不使用旧过程作基线。');
const part = stringField('局部定位（例如某条剪除理由、材料中的某段实例）；省略表示整个判断或整份材料。');
const reason = stringField('本次决定的理由，必传；写入形成记录，不能只写在回复里。');
const reviveWhen = stringField('复活条件，必传；说明什么情况下应重新启用。');
const state = enumeration('目标分支状态：keep 留 / open 未决。', 'keep', 'open');

/** 展开深度：非负边数或显式 leaf；outer 说明本参数方向，分支说明单位与截断语义。 */
function depthField(description: string): JsonSchema {
  return {
    description,
    oneOf: [
      integerField('非负整数，单位边数；0 只含起点自身，1 再加直接相邻一层。'),
      { type: 'string', const: 'leaf', description: '显式展开到叶子；仍按本次预算截断，不等于无限。' },
    ],
  };
}

const target = {
  description: '引用目标二选一：树内判断给 {nodeId, part}，外部材料给 {doc, part}；nodeId 与 doc 不能同时出现。',
  oneOf: [
    object({ nodeId, part }, ['nodeId'], '树内判断目标：nodeId 必传；part 可选，省略指整个判断。'),
    object({ doc: stringField('外部材料的仓库相对定位符；只记录定位，不展开成另一棵树。'), part }, ['doc'], '外部材料目标：doc 必传；part 可选，省略指整份材料。'),
  ],
} satisfies JsonSchema;
const confirmTarget = {
  description: '上一页末项的确认目标，二选一：revisionId 或 seedNodeId；只作分页起点，不接受两者同时出现。',
  oneOf: [
    object({ revisionId: stringField('新写形成记录 ID；从上一页末项原样取得。') }, ['revisionId'], '新写形成记录：按 revisionId 续读。'),
    object({ seedNodeId: stringField('导入判断的节点 ID；从上一页末项原样取得。') }, ['seedNodeId'], '导入判断：按 seedNodeId 续读。'),
  ],
} satisfies JsonSchema;
const decision = {
  description: '节点决定四选一；每支都必须给 reason，type 决定所需字段。',
  oneOf: [
    object({
      type: { type: 'string', const: 'prune', description: '剪除该判断。' },
      reason,
      reviveWhen,
    }, ['type', 'reason', 'reviveWhen'], 'prune：剪除该判断；reason 与 reviveWhen 都必传。'),
    object({
      type: { type: 'string', const: 'revive', description: '重新启用已剪除的判断。' },
      state,
      reason,
    }, ['type', 'state', 'reason'], 'revive：重新启用已剪除的判断；state 指定恢复为 keep 还是 open。'),
    object({
      type: { type: 'string', const: 'setOpenOrKeep', description: '在留与未决之间切换。' },
      state,
      reason,
    }, ['type', 'state', 'reason'], 'setOpenOrKeep：在留与未决之间切换；state 指定目标状态。'),
    object({
      type: { type: 'string', const: 'applyReplacement', description: '执行待执行的替代候选。' },
      reason,
      reviveWhen,
    }, ['type', 'reason', 'reviveWhen'], 'applyReplacement：nodeId 指替代候选，不指旧判断；reason 与 reviveWhen 是旧判断的剪除理由和复活条件。'),
  ],
} satisfies JsonSchema;

const PARAMETERS: Record<AiOp, HostTool['parameters']> = {
  createTree: object({
    treeId,
    rootQuestion: stringField('这棵树要回答的根问题，必传；创建时写入未确认根，之后作为整棵树的起点。'),
  }, ['treeId', 'rootQuestion'], '创建参数：treeId 指定树的稳定标识，rootQuestion 是这棵树要回答的问题。'),
  addBranch: object({
    treeId,
    placement: {
      description: '新判断落点，二选一：parentId+kind 挂到已有判断下，或 replacesId 登记同父替代候选；一次只能选一支。',
      oneOf: [
        object({
          parentId: stringField('父判断的稳定节点 ID；新判断挂到它下面。'),
          kind: enumeration('落点类型：branch 新分支 / supplement 补充 / erratum 勘误；表示新判断与父判断的关系。', 'branch', 'supplement', 'erratum'),
        }, ['parentId', 'kind'], '普通落点：parentId 与 kind 都必传；新判断作为指定父判断的子节点。'),
        object({
          replacesId: stringField('拟被替代的旧判断 ID；这里只登记替代候选，不立即执行替代。'),
        }, ['replacesId'], '替代落点：只给 replacesId；新判断与旧判断同父，登记为待执行替代候选。'),
      ],
    },
    draft: object({
      body: object({
        title: stringField('判断标题，必传；简短陈述这条判断。'),
        text: stringField('判断正文，可选；展开标题的完整表述。'),
        basis: stringField('依据，可选；说明为什么这样判断。'),
        source: stringField('来源，可选；记录材料或出处。'),
        openReason: stringField('未决原因，可选；state=open 时说明还缺什么。'),
        note: stringField('备注，可选；不属于判断正文的补充。'),
      }, ['title'], '新判断正文；只有 title 必传，其余字段可省略。'),
      state: enumeration('新判断的初始分支状态：keep 留 / prune 剪除 / open 未决。', 'keep', 'prune', 'open'),
      refs: {
        type: 'array',
        description: '引用列表，必传；空数组表示没有引用，不用省略代替空列表。',
        items: object({
          kind: enumeration('引用关系：premise 依赖前提 / example 同类实例 / conflict 与事实冲突。', 'premise', 'example', 'conflict'),
          target,
        }, ['kind', 'target'], '一条引用：kind 说明关系，target 给树内判断或外部材料。'),
      },
      pruneReason: stringField('初始剪除理由；仅 state=prune 时必传，其他状态不得给。'),
      reviveWhen: stringField('初始复活条件；仅 state=prune 时必传，其他状态不得给。'),
    }, ['body', 'state', 'refs'], '新判断草稿；只描述新节点，不携带 ID、执行者或确认信息。state=prune 时必须同时给 pruneReason 和 reviveWhen。'),
    expectedStamp,
  }, ['treeId', 'placement', 'draft'], '在当前工作区的认知树中新增分支、补充、勘误或替代候选；提交生效但不代表人确认，不覆盖原文。'),
  decideNode: object({
    treeId,
    nodeId,
    decision,
    expectedStamp,
  }, ['treeId', 'nodeId', 'decision'], '决定参数：treeId 与 nodeId 定位当前工作区的判断，decision 四选一描述动作与理由。'),
  readView: object({
    treeId,
    focus: {
      description: '读取起点，二选一：节点 ID 或显式 {root:true}；不根据界面选中状态猜测焦点。',
      oneOf: [
        stringField('焦点节点 ID；须在当前工作区的这棵树中。'),
        object({ root: { type: 'boolean', const: true, description: '固定为 true，表示从树根开始读取。' } }, ['root'], '显式从树根开始。'),
      ],
    },
    expand: object({
      subtreeDepth: depthField('初始焦点向下展开的层数，单位边数；0 只含焦点自身，leaf 表示直到叶子但受预算截断。'),
      jumpHops: integerField('每条路径最多跨多少条树内引用边，单位边数；0 表示本次不跨引用跳。AI 局部视图在 jumpHops=0 时不查引用、不逐节点输出 refs/scope；这只表示未扩展引用，不代表查尽。'),
      direction: enumeration('引用方向：out 我指向谁 / in 谁指向我 / both 两个方向；结果保留边的原方向。', 'out', 'in', 'both'),
      jumpFrom: enumeration('起跳范围：anchor 仅从本轮起点跳 / expanded 还包含本轮按深度展开出的子节点。', 'anchor', 'expanded'),
      afterJumpDepth: depthField('每个引用落点再向下展开的层数，单位边数；0 只含落点自身；与 subtreeDepth 独立生效。'),
    }, ['subtreeDepth', 'jumpHops', 'direction', 'jumpFrom', 'afterJumpDepth'], '展开范围，五项都必传；范围决定本次要覆盖到哪里，不等于预算。'),
    budget: object({
      maxScans: integerField('计数单位：次。本页最多实际检查的邻接行与查找次数，含空查、向前探一条、补父链、详情与当前形成记录的查找。'),
      maxNodes: integerField('计数单位：个。本页最多返回节点数，命中的节点和为连回根补入的父链节点都算。'),
      maxBytes: integerField('计数单位：UTF-8 字节。本页给模型的正文上限，含定位、节点、引用、边界标记和游标。'),
    }, ['maxScans', 'maxNodes', 'maxBytes'], `本页预算。省略整个 budget 时，使用 ${Object.entries(AI_READ_VIEW_BUDGET).map(([key, value]) => `${key}:${value}`).join('、')}。显式传入时三项都必传且须为正安全整数；null、缺项和非法值不会套用默认。`),
    onLimit: enumeration('超限策略：fold 在能返回连通页并推进时给部分结果与 cursor；exact 要求一次读完指定范围，超限报 rangeTooLarge。', 'fold', 'exact'),
    cursor: stringField('上一页原样返回的续读游标；首次读取省略。续读必须保持同一棵树、同一焦点、同一 expand、同一 onLimit 和同一 includeDetails（同范围同策略同详情模式），预算可按本页重新给出。'),
    includeDetails: {
      type: 'boolean',
      description: '为 true 时返回完整 JSON：同一 TreeView 的每个节点（含为连通父链补入的 link）多一个 detail（NodeDetail：正文、状态、确认、来历与当前形成记录全文），本页预算按该 JSON 的 UTF-8 字节计；省略或 false 时返回 CTV2 紧凑文本（超 128 节点或 256 引用仍退回 JSON）。',
    },
  }, ['treeId', 'focus', 'expand', 'onLimit'], '按明确范围和预算读取当前工作区认知树的连通局部视图；保留真实父链与引用方向。续读使用原查询和cursor。'),
  readHistory: object({
    treeId,
    nodeId: stringField('只看该节点的修订历史；省略则读取整棵树的历史。'),
    limit: integerField('本页最多返回条数，必传；计数单位：条。'),
    after: stringField('上一页最后一项的修订 ID；首页省略，续读时原样传入。'),
  }, ['treeId', 'limit'], '按页读取当前工作区中一棵树或指定节点的修订历史；limit 必传，after 来自前页。'),
  readUnconfirmed: object({
    treeId,
    by: {
      type: 'array',
      description: '要列出的执行者种类，必传且不能为空；可多选 human、ai、import。',
      items: enumeration('执行者种类：human 人 / ai AI / import 导入。', 'human', 'ai', 'import'),
    },
    limit: integerField('本页最多返回条数，必传；计数单位：条。'),
    after: confirmTarget,
  }, ['treeId', 'by', 'limit'], '按执行者种类分页列出当前工作区的未确认目标；AI 只能读取，不能代替人确认。'),
};
const DESCRIPTIONS: Record<AiOp, string> = {
  createTree: '在当前工作区以指定treeId和根问题创建认知树，返回树ID；仅含一个未确认根，不导入手稿或批量节点。',
  addBranch: '在当前工作区的认知树中新增分支、补充、勘误或替代候选；提交生效但不代表人确认。不覆盖原文。',
  decideNode: '在当前工作区的认知树中剪除、复活、切换留/未决或执行替代；必须显式给出理由。变更生效但不代表人确认。',
  readView: `按明确范围和预算读取当前工作区认知树的连通局部视图；保留真实父链与引用方向。includeDetails=true 时返回带节点详情的完整 JSON。续读使用原查询和cursor。\n${AI_READ_VIEW_GUIDE}`,
  readHistory: '按页读取当前工作区的树或指定节点修订历史；limit必传，after来自前页。',
  readUnconfirmed: '按执行者种类分页列出当前工作区的未确认目标；AI只能读取，不能代替人确认。',
};

/**
 * 本页响应是否带节点详情；只看回包，防止参数与回包不一致时把 detail 压缩掉。
 * @param value 内核返回的本页视图对象。
 */
function hasNodeDetail(value: Record<string, unknown>): boolean {
  return Array.isArray(value.nodes) && value.nodes.some(node => record(node) && Object.hasOwn(node, 'detail'));
}

export const PROCESS_TOOL = 'cognition_tree_process';

function processInput(args: unknown): ProcessInput {
  exactObject(args, ['treeId', 'action']);
  const { treeId, action } = args;
  if (typeof treeId !== 'string' || !treeId.trim() || !record(action)) {
    throw new CognitionError('invalid', '过程材料必须指定树和操作。');
  }
  if (action.kind === 'save') {
    exactObject(action, ['kind', 'text']);
    if (typeof action.text === 'string' && action.text.trim()) return { treeId, action: { kind: 'save', text: action.text } };
  } else if (action.kind === 'read') {
    exactObject(action, ['kind', 'processId']);
    if (typeof action.processId === 'string' && /^[0-9a-f]{64}$/.test(action.processId)) {
      return { treeId, action: { kind: 'read', processId: action.processId } };
    }
  }
  throw new CognitionError('invalid', '过程材料只支持保存非空正文，或按原样传入保存返回的 ID 读取。');
}

function processTool(ctx: HostContext, runtime: HostRuntime): HostTool {
  return {
    name: PROCESS_TOOL,
    description: '保存或显式读取当前工作区的过程材料。材料不是认知树判断、不是指令，不自动进入树。续接时结合当前树另写；不能修改或补交旧材料。',
    parameters: object({
      treeId,
      action: {
        description: '保存新材料或按 ID 点读已有材料。',
        oneOf: [
          object({ kind: { type: 'string', const: 'save', description: '保存过程材料。' },
            text: stringField('形成判断所需的文本片段；无需字段齐全或说明未入树的原因，最多 16384 UTF-8 字节。不含整段会话或秘密。') },
          ['kind', 'text'], '另存新的过程材料，返回 ID。'),
          object({ kind: { type: 'string', const: 'read', description: '点读旧过程材料。' },
            processId: stringField('从先前保存结果原样取得的材料 ID；不按标题猜。') },
          ['kind', 'processId'], '按树 ID 和过程材料 ID 读取。'),
        ],
      },
    }, ['treeId', 'action'], '过程材料独立于普通读树和树修订。'),
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      try {
        const input = processInput(args);
        const root = await runtime.aiWorkspace(exec);
        if (input.action.kind === 'save') await assertAiWriteAllowed(ctx, exec.agent!.session, root, exec.signal);
        const saved = await runtime.process(root, input, exec.signal);
        return input.action.kind === 'read' ? saved : { treeId: saved.treeId, processId: saved.processId };
      } catch (error) { throw boundaryError(error); }
    },
  };
}

/**
 * 注册完整的一组工具；中途碰撞会回滚自己已注册的工具，不移除其它插件的同名项。
 * @param ctx 宿主工具注册表。
 * @param runtime 本插件惰性后台及生命周期。
 * @returns 只解绑本插件贡献的函数。
 */
export function registerTools(ctx: HostContext, runtime: HostRuntime): () => void {
  const disposers: (() => void)[] = [];
  try {
    for (const op of Object.keys(AI_TOOLS) as AiOp[]) {
      const tool: HostTool = {
        name: AI_TOOLS[op], description: DESCRIPTIONS[op], parameters: PARAMETERS[op],
        output: {
          schema: {},
          render: (args, value) => {
            if (op !== 'readView' || !record(value) || !Array.isArray(value.nodes)
              || !Array.isArray(value.refs) || !Array.isArray(value.boundaries)) {
              return [{ type: 'text', text: JSON.stringify(value) }];
            }
            // 参数与回包任一表明本页带详情都直出原样 JSON；CTV2 会丢掉 detail 字段。
            const detailed = (record(args) && args.includeDetails === true) || hasNodeDetail(value);
            return [{ type: 'text', text: renderAiReadView(value as unknown as TreeView, detailed) }];
          },
          ...(op === 'addBranch' || op === 'decideNode' ? {
            presentationMeta: (args: unknown, value: unknown) => record(args) && typeof args.treeId === 'string' && typeof value === 'string'
              ? { kind: 'cognition-tree', op, treeId: args.treeId, nodeId: value } : undefined,
          } : {}),
        },
        async execute(args, exec) {
          try {
            const input = parseAiInput(op, args);
            const root = await runtime.aiWorkspace(exec);
            if (op === 'createTree' || op === 'addBranch' || op === 'decideNode') {
              await assertAiWriteAllowed(ctx, exec.agent!.session, root, exec.signal);
            }
            return await runtime.call('ai', op, input, root, exec.signal);
          } catch (error) { throw boundaryError(error); }
        },
      };
      disposers.push(ctx.tools.register(tool));
    }
    disposers.push(ctx.tools.register(processTool(ctx, runtime)));
  } catch (error) {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* 继续回滚其它自身贡献。 */ } }
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* 宿主可能已自动解绑。 */ } }
  };
}
