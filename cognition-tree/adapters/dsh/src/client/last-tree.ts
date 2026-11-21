/**
 * 最近打开的树：按 DSH 会话记在本机浏览器里。
 *
 * 只保存会话 ID 与树 ID（以及写入时间），不保存判断内容，不写服务端、不进数据库。
 * 作用：面板重新打开时回到该会话上次看的那棵树；人显式回到「全部树」时清掉这条记录。
 * localStorage 不可用（隐私模式、被策略禁用）时静默退化为“不记”，不影响读写树。
 */
import type { TreeId } from '@cognition-tree/kernel/types';

/** 存储键；同源下与其它插件的键互不干扰。 */
const KEY = 'dsh-cognition-tree:last-tree';

/** 最多记住多少个会话，超出时丢最旧的；会话 ID 很多时不无限增长。 */
const MAX_ENTRIES = 50;

/** 树 ID 的合法形态：与工作区文件名规则一致，首位字母或数字，最多 64 位。 */
const TREE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 一条记录：树 ID 与写入时间（毫秒），时间只用于淘汰最旧的会话。 */
interface Entry {
  treeId: string;
  at: number;
}

/** 存储内容：会话 ID → 记录。 */
type Store = Record<string, Entry>;

/** 取浏览器的 localStorage；不可用时返回 null，调用方按“不记”处理。 */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读整个存储；坏数据当作没有，不让一条脏记录挡住面板打开。 */
function readStore(storage: Storage): Store {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<Entry> | null;
      if (entry && typeof entry.treeId === 'string' && TREE_ID.test(entry.treeId) && typeof entry.at === 'number') {
        out[sessionId] = { treeId: entry.treeId, at: entry.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 写回整个存储；超出上限时只留最近的若干会话。写失败（配额、隐私模式）时静默忽略。 */
function writeStore(storage: Storage, store: Store): void {
  const entries = Object.entries(store).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
  try {
    storage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 存不进去就不记，下次打开回到目录。
  }
}

/**
 * 读某个会话上次打开的树。
 * @param sessionId 宿主会话 ID
 * @param storage 可选的存储实现；测试用，缺省用浏览器 localStorage
 * @returns 树 ID；没有记录或记录不可用时为 null
 */
export function readLastTree(sessionId: string, storage: Storage | null = defaultStorage()): TreeId | null {
  if (!storage || !sessionId) return null;
  const entry = readStore(storage)[sessionId];
  return entry ? (entry.treeId as TreeId) : null;
}

/**
 * 记下某个会话最后打开的树。
 * @param sessionId 宿主会话 ID
 * @param treeId 刚成功打开的树 ID；不合法的 ID 不写入
 * @param storage 可选的存储实现；测试用，缺省用浏览器 localStorage
 */
export function writeLastTree(sessionId: string, treeId: TreeId, storage: Storage | null = defaultStorage()): void {
  if (!storage || !sessionId || !TREE_ID.test(treeId)) return;
  const store = readStore(storage);
  store[sessionId] = { treeId, at: Date.now() };
  writeStore(storage, store);
}

/**
 * 清掉某个会话的记录：人显式回到「全部树」时调用，下次打开面板显示目录。
 * @param sessionId 宿主会话 ID
 * @param storage 可选的存储实现；测试用，缺省用浏览器 localStorage
 */
export function clearLastTree(sessionId: string, storage: Storage | null = defaultStorage()): void {
  if (!storage || !sessionId) return;
  const store = readStore(storage);
  if (!(sessionId in store)) return;
  delete store[sessionId];
  writeStore(storage, store);
}
