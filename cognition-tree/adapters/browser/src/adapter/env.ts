/**
 * 浏览器适配层 · 页内装配
 *
 * 职责：把一个页面会话接到正式内核和 localStorage 测试存储上，并按入口身份给出调用点：
 * - human：实现 UI 的 CognitionClient，actor 固定为 'human'；
 * - ai：开发坞 AI 模拟器的调用点，actor 固定为 'ai'；能调用什么由内核操作目录决定，
 *   越权（例如以 AI 身份人确认）由 catalog 拒绝，这里不另做判断；
 * - bridge：HostBridge 的浏览器实现，打开出处时在页内阅读研究材料原文；
 * - dev：开发坞的延迟、失败注入、真实存储字节与最近一次读取返回量。
 *
 * 状态归属：树事实在内核与 MemoryTreeStore，持久化在 TreeJournal，提交通知在 ChangeHub。
 * 本文件只做装配，不解释命令规则，不写入第二份树状态。
 * 边界：actor 只在这里按调用点固定，不从请求里读取；测试存储与 DSH 的 .converge/ 数据隔离。
 */
import { createKernel } from '@cognition-tree/kernel/catalog';
import type { OpInput, OpName, OpOutput } from '@cognition-tree/kernel/catalog/contracts';
import type { DailyActor, TreeId } from '@cognition-tree/kernel/types';
import type { CognitionClient, HostBridge } from '@cognition-tree/ui/types/ports';
import { systemClock } from './clock';
import { ChangeHub } from './changes';
import { BrowserDevControls, type DevControls } from './dev';
import { LocalStorageTreeStore } from './storage/localstorage-store';
import { createSourceReader, type SourceReaderStore } from './source/source-reader';

/** AI 模拟器的调用点：可以请求任何操作，由操作目录按身份放行或拒绝。 */
export interface AiCaller {
  call<K extends OpName>(op: K, input: OpInput[K]): Promise<OpOutput[K]>;
}

export interface BrowserEnv {
  treeId: TreeId;
  human: CognitionClient;
  ai: AiCaller;
  bridge: HostBridge;
  reader: SourceReaderStore;
  dev: DevControls;
}

/** 会写树的操作；成功后取走本次提交并通知 UI。 */
const WRITE_OPS: ReadonlySet<OpName> = new Set(['createTree', 'addBranch', 'decideNode', 'confirm', 'bootstrapTree']);

/**
 * 从操作参数里取目标树：自举的树在 seed 里，其余操作都有 treeId。
 * @param op 操作名
 * @param input 该操作的参数
 */
function treeIdOf<K extends OpName>(op: K, input: OpInput[K]): TreeId {
  if (op === 'bootstrapTree') return (input as OpInput['bootstrapTree']).seed.treeId;
  return (input as { treeId: TreeId }).treeId;
}

/**
 * 焦点描述，只用于开发坞观测。
 * @param input readView 的参数
 */
function focusLabel(input: OpInput['readView']): string {
  return typeof input.focus === 'string' ? input.focus : '根';
}

/**
 * 组装浏览器环境。
 * @param opts.treeId 页面使用的树
 * @param opts.repoRoot Converge 仓库根（正斜杠），打开出处时据此定位研究材料
 * @param opts.storage 测试存储，缺省为 window.localStorage
 * @returns 人 / AI / 宿主桥 / 开发坞端口
 */
export function createBrowserEnv(opts: { treeId: TreeId; repoRoot: string; storage?: Storage }): BrowserEnv {
  const storage = opts.storage ?? window.localStorage;
  const store = new LocalStorageTreeStore({ storage });
  const kernel = createKernel({ store, clock: systemClock });
  const hub = new ChangeHub();
  const dev = new BrowserDevControls(store, opts.treeId);
  /** 写操作按树串行化，保证“取走本次提交”的顺序与提交顺序一致。 */
  const writeChains = new Map<TreeId, Promise<unknown>>();

  /**
   * 按入口身份调用内核；写成功后通知 UI 读回，读成功后记录真实返回量。
   * 模拟延迟在调用前发生；失败注入在持久化点发生，由 store 回滚。
   */
  const run = async <K extends OpName>(actor: DailyActor, op: K, input: OpInput[K]): Promise<OpOutput[K]> => {
    const delay = dev.latency();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const treeId = treeIdOf(op, input);
    if (WRITE_OPS.has(op)) {
      const previous = writeChains.get(treeId) ?? Promise.resolve();
      // 把“调用、取走本次提交、通知”放进同一条串行链：下一次写不会在通知前开始，
      // 失败时也只丢弃属于自己的那条待通知记录。
      const task = previous.catch(() => undefined).then(async () => {
        try {
          const out = await kernel.dispatch(actor, op, input);
          const commit = store.takeCommit(treeId);
          if (commit) {
            dev.noteCommit();
            hub.publish({ treeId, stamp: commit.stamp, revisions: commit.revisions });
          }
          return out;
        } catch (e) {
          store.discardCommit(treeId);
          throw e;
        }
      });
      writeChains.set(treeId, task);
      try {
        return await task;
      } finally {
        if (writeChains.get(treeId) === task) writeChains.delete(treeId);
      }
    }
    const out = await kernel.dispatch(actor, op, input);
    if (op === 'readView') {
      const params = input as OpInput['readView'];
      dev.observeRead(out as OpOutput['readView'], params.budget, params.onLimit, focusLabel(params));
    }
    return out;
  };

  const human: CognitionClient = {
    call(op, input) {
      return run('human', op, input);
    },
    watch(treeId, listener) {
      return hub.subscribe(treeId, listener);
    },
  };
  const ai: AiCaller = {
    call(op, input) {
      return run('ai', op, input);
    },
  };
  const reader = createSourceReader(opts.repoRoot);
  const bridge: HostBridge = { openSource: (target) => reader.open(target.doc, target.part) };

  return { treeId: opts.treeId, human, ai, bridge, reader, dev };
}
