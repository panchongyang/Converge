/**
 * 内核公开操作目录（接口单 §3.1）。装配一次模型与查询会话；本层只识别操作和可信身份，
 * 不保存树、不分配节点 ID，也不发布 UI 通知。存储端口和时钟来自宿主或测试。
 */
import { createWriteModel, requireExpectedStamp } from '../models';
import { createQueries, type ViewWireCost } from '../queries';
import { CognitionError, type Clock, type DailyActor, type TreeStore } from '../types';
import type { OpInput, OpName, OpOutput } from './contracts';

/** 适配器唯一的业务入口。读写使用相同目录，不向调用者交出底层事务句柄。 */
export interface Kernel {
  /**
   * 分派一项意图；拒绝未知操作与越权，业务错误由相应命令或查询说明。
   * @param actor 可信调用点绑定的身份；不会以 input 中的字段覆盖
   * @param op 已声明的操作名
   * @param input 该操作的具名参数（无通用 patch 或默认目标）
   * @returns 已提交写入的 ID，或一致读的结果；失败不返回部分提交
   */
  dispatch<K extends OpName>(actor: DailyActor, op: K, input: OpInput[K]): Promise<OpOutput[K]>;
}

/** 每项把其签名、权限与执行方法放在一起；类型映射保证分派后仍返回同一操作的结果。 */
type Operations = { [K in OpName]: {
  access: 'human' | 'both';
  run: (actor: DailyActor, input: OpInput[K]) => Promise<OpOutput[K]>;
} };

/** 只在字段确实省略时使用无护栏的旧写入路径。 */
function optionalStamp(input: { expectedStamp?: number }): number | undefined {
  return Object.hasOwn(input, 'expectedStamp') ? requireExpectedStamp(input.expectedStamp) : undefined;
}

/**
 * 用注入端口组装这一实例的用例；不同实例不共享查询游标或监听者。
 * @param deps.store 读已提交快照、原子提交单树更改的端口
 * @param deps.clock 模型给新修订取实际时刻的端口；自举保留原时间精度
 * @param deps.aiViewCost AI 局部视图的可选模型输出度量；人侧 JSON 和操作结果结构不变
 */
export function createKernel(deps: { store: TreeStore; clock: Clock; aiViewCost?: ViewWireCost }): Kernel {
  const write = createWriteModel(deps.store, deps.clock);
  const read = createQueries(deps.store, deps.aiViewCost);
  const operations: Operations = {
    createTree: { access: 'both', run: (actor, p) => write.createTree(actor, p) },
    addBranch: { access: 'both', run: (actor, p) => write.addBranch(actor, p.treeId, p.placement, p.draft, optionalStamp(p)) },
    decideNode: { access: 'both', run: (actor, p) => write.decideNode(actor, p.treeId, p.nodeId, p.decision, optionalStamp(p)) },
    confirm: { access: 'human', run: (_, p) => write.confirm(p.treeId, p.target) },
    bootstrapTree: { access: 'human', run: (_, p) => write.bootstrapTree(p.seed) },
    readNode: { access: 'both', run: (_, p) => read.readNode(p.treeId, p.nodeId) },
    readHistory: { access: 'both', run: (_, p) => read.readHistory(p.treeId, p) },
    readUnconfirmed: { access: 'both', run: (_, p) => read.readUnconfirmed(p.treeId, p) },
    // AI 已在请求中给出零跳数，不必把同一个未查询范围贴到每个命中；人侧保留节点上的入口提示。
    readView: {
      access: 'both',
      run: (actor, p) => read.readView(
        p.treeId, p.focus, p.expand, p.budget, p.onLimit, p.cursor, actor === 'ai', p.includeDetails,
      ),
    },
  };
  return {
    async dispatch<K extends OpName>(actor: DailyActor, op: K, input: OpInput[K]): Promise<OpOutput[K]> {
      if (!Object.hasOwn(operations, op)) throw new CognitionError('invalid', `未知操作：${String(op)}`);
      const operation = operations[op];
      if ((actor !== 'human' && actor !== 'ai') || (operation.access === 'human' && actor !== 'human')) {
        throw new CognitionError('invalid', `该入口无权调用 ${op}`);
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new CognitionError('invalid', `${op} 缺少操作参数`);
      }
      return operation.run(actor, input);
    },
  };
}
