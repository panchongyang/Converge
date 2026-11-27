/**
 * SQLite 专用工作线程入口。按消息到达顺序分派，确保关闭落在所有先前请求之后。
 * 连接、快照及续读状态仅在此线程内共存；不同工作区分别组装内核，绝不共享事务或游标。
 */
import { isAbsolute } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { createKernel, type Kernel } from '@cognition-tree/kernel/catalog';
import { CognitionError } from '@cognition-tree/kernel/types';
import { aiReadViewCost } from '../ai-view-wire';
import { SqliteTreeStore } from '../storage';
import { readProcess, saveProcess } from '../storage/process';
import type { Request, Reply } from './protocol';

/** 每个工作区一套内核与读会话；游标的进程代际和字节预算均由查询层核算。 */
interface Workspace { store: SqliteTreeStore; kernel: Kernel; touched: number }
const workspaces = new Map<string, Workspace>();
const idleMs = 90_000; // 高于内核视图 60 秒的绝对期限；不依赖再次打开插件才能释放 WAL 读锁。
const channel = parentPort;
if (!channel) throw new Error('SQLite 后端须由认知树插件工作线程启动。');

/** 把本次结果送回创建该线程的插件。@param message 已完成的结果或提交后通知 */
function send(message: Reply): void { channel!.postMessage(message); }

/**
 * 获取宿主已绑定的工作区；有限数量的独立连接组防止遍历会话导致插件自身无限占用。
 * @param root 宿主解析的工作区绝对路径，不能来自业务载荷
 */
async function workspace(root: string): Promise<Workspace> {
  if (!isAbsolute(root)) throw new CognitionError('invalid', '缺少已绑定的工作区。');
  const cached = workspaces.get(root);
  if (cached) { cached.touched = Date.now(); return cached; }
  if (workspaces.size >= 16) throw new CognitionError('storage', '使用中的认知树工作区过多，请稍后再试。');
  const store = new SqliteTreeStore(root, change => send({ kind: 'commit', root, change }));
  const entry = { store, touched: Date.now(),
    kernel: createKernel({ store, clock: { now: () => new Date().toISOString() }, aiViewCost: aiReadViewCost }) };
  workspaces.set(root, entry);
  return entry;
}

/**
 * 分派一个请求；业务错误保留 code，其余 I/O/线程异常只向本插件调用方报告。
 * @param message 已通过宿主入口限制的请求，close 是卸载时的最后一条控制消息
 */
async function handle(message: Request): Promise<void> {
  if (message.kind === 'close') {
    clearInterval(reaper);
    try { for (const item of workspaces.values()) await item.store.close(); }
    finally { workspaces.clear(); channel!.close(); }
    return;
  }
  try {
    if (message.kind === 'process') {
      const { root, input: { treeId, action } } = message;
      if (action.kind === 'save') {
        const { store } = await workspace(root);
        // 留档归属一棵现存的树，但不对它开写事务。
        const tree = await store.openRead(treeId);
        await tree.close();
      }
      const value = action.kind === 'save'
        ? saveProcess(root, treeId, action.text)
        : readProcess(root, treeId, action.processId);
      send({ kind: 'ok', id: message.id, value });
      return;
    }
    const entry = await workspace(message.root);
    const value = message.kind === 'listTrees'
      ? await entry.store.listTrees()
      : await entry.kernel.dispatch(message.actor, message.op, message.input);
    send({ kind: 'ok', id: message.id, value });
  } catch (error) {
    send({ kind: 'error', id: message.id, code: error instanceof CognitionError ? error.code : 'storage',
      message: error instanceof CognitionError ? error.message : '认知树后端调用失败。' });
  }
}

let queue = Promise.resolve();
// 与调用在同一队列清理，不在一个异步事务中途关连接；定时器不占用 DSH 主线程。
const reaper = setInterval(() => {
  queue = queue.then(async () => {
    for (const [root, item] of workspaces) if (Date.now() - item.touched >= idleMs) {
      workspaces.delete(root); await item.store.close();
    }
  }).catch(() => { /* 某工作区释放失败不影响下一条请求。 */ });
}, idleMs).unref();
channel.on('message', (message: Request) => { queue = queue.then(() => handle(message)).catch(() => { channel.close(); }); });
