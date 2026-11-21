/**
 * 写侧唯一提交入口（内核接口单 §3.1、§3.3、§3.4）。模型只协调 TreeStore / Clock、
 * 事务内命令与实际写集，不另存树数据。catalog 把关调用身份，模型不从业务输入识别 actor；
 * 人的确认和自举方法只能装配到人入口。写入、修订和索引同笔提交成功后才返回 ID。
 */
import { planAddBranch, planConfirmation, planDecision, prepareBootstrap, prepareBranch, prepareCreateTree } from '../commands';
import type { FormationPlan } from '../commands';
import { CognitionError } from '../types';
import type {
  Clock, ConfirmationRevision, ConfirmTarget, DailyActor, Decision, Draft, FormationRevision,
  NodeId, Placement, RevisionId, SeedTree, TreeId, TreeStore, WriteTransaction,
} from '../types';
import { isNonBlank } from '../utils';
import { allocateNodeId, allocateRefIds, allocateRevisionId, importedRevisionId } from './identifiers';

/** 一次新日志所需的同一时刻和事务内分配的稳定修订 ID。 */
interface NewRevision { id: RevisionId; at: string }

/**
 * 装配可信 catalog 使用的写侧模型，不持有树或复制权限目录。
 * @param store 提供现有树或新建树的原子事务，保存失败时回滚数据、版本与修订
 * @param clock 为每次新形成或确认提供含时区的当前时刻，自举不调用
 * @returns 接受已识别的日常 actor 及人专用的确认和自举方法
 */
export function createWriteModel(store: TreeStore, clock: Clock) {
  return {
    /**
     * 原子提交新树的唯一根与本次形成记录；人或 AI 创建后都仍需另行人确认。
     * @param actor catalog 核验后的日常执行者
     * @param input 仅含显式树 ID 与根问题的新建意图；在打开存储前校验
     * @returns 提交完成后的树 ID，也是根的节点 ID
     * @throws CognitionError 输入不合规、树已存在或保存失败（invalid / storage）
     */
    async createTree(actor: DailyActor, input: unknown): Promise<TreeId> {
      requireDailyActor(actor);
      const { treeId, plan } = prepareCreateTree(input);
      return write(store, treeId, 'createNew', async (transaction) => {
        const revision = await newRevision(transaction, clock);
        commitFormation(transaction, plan, actor, revision);
        return treeId;
      });
    },

    /**
     * 保存一个普通子判断、补充、勘误或替代候选并记形成；保存不等于人确认。
     * @param actor catalog 核验后的日常执行者，不能改由草稿提供
     * @param treeId 已选的目标树
     * @param placement 明确落点，父节点与被替代节点二选一
     * @param draft 仅用于新节点的正文、初始状态和引用
     * @returns 提交完成后返回新节点的稳定 ID
     * @throws CognitionError 无效意图或目标不存在、保存失败（invalid / missing / storage）
     */
    async addBranch(actor: DailyActor, treeId: TreeId, placement: Placement, draft: Draft): Promise<NodeId> {
      requireDailyActor(actor);
      return write(store, treeId, 'existing', async (transaction) => {
        const branch = await prepareBranch(transaction, placement, draft);
        const revision = await newRevision(transaction, clock);
        const id = await allocateNodeId(transaction, revision.id);
        commitFormation(transaction, planAddBranch(branch, id), actor, revision);
        return id;
      });
    },

    /**
     * 执行一次剪除、重新启用、留/未决转换或替代；不覆盖正文、不自动人确认。
     * @param actor catalog 核验后的日常执行者
     * @param treeId 已选的目标树
     * @param nodeId 被操作的原节点 ID，执行替代时指候选
     * @param decision 明确的状态决定与理由
     * @returns 提交完成后返回被操作的原节点 ID
     * @throws CognitionError 无效意图或目标不存在、保存失败（invalid / missing / storage）
     */
    async decideNode(actor: DailyActor, treeId: TreeId, nodeId: NodeId, decision: Decision): Promise<NodeId> {
      requireDailyActor(actor);
      return write(store, treeId, 'existing', async (transaction) => {
        const plan = await planDecision(transaction, nodeId, decision);
        const revision = await newRevision(transaction, clock);
        commitFormation(transaction, plan, actor, revision);
        return nodeId;
      });
    },

    /**
     * 明确确认指定形成记录或导入判断，只更新仍绑定该目标的确认程度；仅由已核验的人入口调用。
     * @param treeId 已选的目标树
     * @param target 人看见并选择的确认对象，不能调用任意确认逻辑
     * @returns 提交完成后返回新的人确认记录 ID
     * @throws CognitionError 目标不存在、过期/重复或保存失败（missing / invalid / storage）
     */
    async confirm(treeId: TreeId, target: ConfirmTarget): Promise<RevisionId> {
      return write(store, treeId, 'existing', async (transaction) => {
        const plan = await planConfirmation(transaction, target);
        const revision = await newRevision(transaction, clock);
        const record: ConfirmationRevision = {
          ...revision,
          kind: 'confirmation',
          by: 'human',
          nodeIds: plan.nodes.map(({ id }) => id),
          summary: plan.summary,
          detail: { target: plan.target },
        };
        for (const node of plan.nodes) transaction.writeNode({ ...node, confirmation: 'humanConfirmed' });
        transaction.appendRevision(record);
        return revision.id;
      });
    },

    /**
     * 仅在目标树不存在时导入译好的种子；保留手稿状态、引用和历史，不新增人确认。
     * @param seed 已由人明确发起、适配器译出的目标树与原历史
     * @returns 提交完成后返回新建目标树 ID
     * @throws CognitionError 输入不合规、树已存在或保存失败（invalid / storage）
     */
    async bootstrapTree(seed: SeedTree): Promise<TreeId> {
      const treeId = seed?.treeId;
      return write(store, treeId, 'createNew', (transaction) => {
        const validated = prepareBootstrap(seed);
        if (validated.treeId !== treeId) throw new CognitionError('invalid', '自举种子与目标树 ID 不一致');
        for (const node of validated.nodes) transaction.writeNode(node);
        for (const ref of validated.refs) transaction.writeRef(ref);
        validated.history.forEach((entry, index) => {
          transaction.appendRevision({ ...entry, id: importedRevisionId(index) });
        });
        return treeId;
      });
    },
  };
}

/**
 * 拒绝非日常执行者的运行时输入；角色授权仍由 catalog 处理。
 * @param actor 已由入口单独提供的身份种类，不读取业务载荷
 */
function requireDailyActor(actor: DailyActor): void {
  if (actor !== 'human' && actor !== 'ai') throw new CognitionError('invalid', '日常变更执行者必须是 human 或 ai');
}

/**
 * 校验目标后调用单树事务，保留业务错误；异常的存储失败不对外报告成功。
 * @param store 负责提交与回滚的树存储
 * @param treeId 唯一目标树，不回退到其他树
 * @param mode 修改/确认要求已有树；新建或自举要求目标树尚不存在
 * @param work 只在该事务内读取域事实并写入明示的变更
 * @returns 端口完成提交后的工作结果
 */
async function write<T>(
  store: TreeStore, treeId: TreeId, mode: 'existing' | 'createNew',
  work: (transaction: WriteTransaction) => T | Promise<T>,
): Promise<T> {
  if (!isNonBlank(treeId)) throw new CognitionError('invalid', '目标树 ID 不能为空白');
  try {
    return await store.transact(treeId, mode, work);
  } catch (error) {
    if (error instanceof CognitionError) throw error;
    throw new CognitionError('storage', '保存树失败，本次写入未提交');
  }
}

/**
 * 只取一次含时区时刻，用于记录及分配同一笔 ID；不为时钟异常补造时间。
 * @param transaction 当前单树事务
 * @param clock 注入的时钟端口
 * @returns 新记录的稳定 ID 与未经改写的原时刻
 */
async function newRevision(transaction: WriteTransaction, clock: Clock): Promise<NewRevision> {
  const at = clock.now();
  const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
  const epochMillis = typeof at === 'string' && isoInstant.test(at) ? Date.parse(at) : NaN;
  if (!Number.isFinite(epochMillis)) throw new CognitionError('storage', '时钟未返回有效的带时区时刻');
  return { id: await allocateRevisionId(transaction, epochMillis), at };
}

/**
 * 把同一组实际效果写向节点和形成日志；关联节点不改当前变更，写入成功才一起生效。
 * @param transaction 当前单树事务
 * @param plan 校验后的实际效果、可选引用与历史关联
 * @param actor catalog 核验的日常执行者，形成人与是否获确认彼此独立
 * @param identity 本条形成记录的稳定 ID 与时刻
 */
function commitFormation(
  transaction: WriteTransaction, plan: FormationPlan, actor: DailyActor, identity: NewRevision,
): void {
  const effects = plan.changes.map(({ effect }) => effect);
  const nodeIds = effects.map(({ nodeId }) => nodeId);
  if (plan.historyAnchor !== undefined && !nodeIds.includes(plan.historyAnchor)) nodeIds.push(plan.historyAnchor);
  const revision: FormationRevision = {
    ...identity, kind: 'formation', by: actor, nodeIds, summary: plan.summary, detail: { ...plan.action, effects },
  };
  const currentChange = { revisionId: revision.id, by: actor };
  for (const { node } of plan.changes) transaction.writeNode({ ...node, currentChange, confirmation: 'unconfirmed' });
  if (plan.outgoing !== undefined) {
    const from = plan.changes[0].node.id;
    const ids = allocateRefIds(from, plan.outgoing.length);
    plan.outgoing.forEach((ref, index) => {
      transaction.writeRef({ ...ref, from, id: ids[index] });
    });
  }
  transaction.appendRevision(revision);
}
