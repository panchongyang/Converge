/**
 * 浏览器测试存储 · 持久化日志
 *
 * 职责：把单树事务提交的增量按“head + 不可变版本键”写进 localStorage，并在重开页面时按序读回。
 * 一次提交只新增一个 delta 键、重写一个很小的 head 键，不重写整棵树或旧历史；localStorage 的
 * 单键 setItem 是原子的，所以先写 delta、再写 head：head 写失败只会留下无人引用的孤儿 delta，
 * 读回时以 head.commits 为准，旧版本不受影响。
 *
 * 边界：只做字节的读写与损坏检测，不解释树语义、不校验命令规则；事务语义、
 * 提交失败回滚由内核的 MemoryTreeStore 负责，本层只把持久化失败翻译成 storage 错误。
 * 命名空间与 P3 原型（converge.cognition-tree.proto.v1:*）分开；原型数据不读取、不覆盖、不删除。
 */
import {
  CognitionError,
  type CognitionNode,
  type Ref,
  type Revision,
  type TreeId,
} from '@cognition-tree/kernel/types';

/** 一条已提交事务的增量；与 MemoryTreeStore.beforeCommit 的 delta 同形。 */
export interface JournalDelta {
  /** 本条事务新增或更新的完整节点行（重放时按 ID 覆盖旧行）。 */
  nodes: CognitionNode[];
  /** 本条事务新增的引用；引用只增不改。 */
  refs: Ref[];
  /** 本条事务追加的修订；只追加，不改写。 */
  revisions: Revision[];
}

/** 重放一条增量时的事务模式；第一条创建树，之后都作用在已有树上。 */
export type JournalMode = 'existing' | 'createNew';

/** 测试存储的版本号；格式变化时加一，旧命名空间不迁移。 */
const STORAGE_VERSION = 1;

/** 新测试存储的键前缀；与原型 v1 分开，避免旧样例数据被新格式误读。 */
export const TEST_STORAGE_PREFIX = 'converge.cognition-tree.test.v2';

export interface JournalHead {
  version: number;
  treeId: TreeId;
  /** 已提交的事务数；也是重放完成后的快照版本。 */
  commits: number;
}

export interface JournalDeltaRecord extends JournalDelta {
  version: number;
  treeId: TreeId;
  /** 从 1 开始的提交序号；键名与它一致。 */
  seq: number;
  mode: JournalMode;
}

/** 判断一个解析结果是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把任意已解析值断言为对象；失败时按损坏处理，不把坏数据当空树。 */
function asRecord(value: unknown, what: string, treeId: TreeId): Record<string, unknown> {
  if (!isRecord(value)) throw corruption(treeId, `${what} 不是对象`);
  return value;
}

/**
 * 生成一条面向人的损坏说明。
 * @param treeId 出问题的树
 * @param detail 具体缺什么或哪里解析不了
 */
function corruption(treeId: TreeId, detail: string): CognitionError {
  return new CognitionError(
    'storage',
    `测试存储里的 ${treeId} 已损坏：${detail}。可在开发坞「清空测试存储」后重新导入样例；原型 v1 的数据不受影响。`,
  );
}

/**
 * 单树测试存储日志。
 * 实例本身不缓存数据；每次读写都直接面向传入的 Storage，便于测试注入内存替身。
 */
export class TreeJournal {
  private readonly storage: Storage;
  private readonly prefix: string;
  /**
   * 每棵树在本命名空间占用的字节数缓存；首次统计扫描一次，之后按成功提交的增量维护。
   * 开发坞每次 render 都读这个数，不能每次遍历全部历史。
   */
  private readonly byteCache = new Map<TreeId, number>();

  /**
   * @param storage 浏览器存储对象（localStorage 或其内存替身）
   * @param prefix 键前缀；缺省使用与原型隔离的测试命名空间
   */
  constructor(storage: Storage, prefix: string = TEST_STORAGE_PREFIX) {
    this.storage = storage;
    this.prefix = prefix;
  }

  /**
   * 读某棵树的提交头；树不存在时返回 null，内容损坏时抛 storage。
   * @param treeId 目标树
   * @returns 已提交事务数；不存在为 null
   */
  head(treeId: TreeId): JournalHead | null {
    const raw = this.storage.getItem(this.headKey(treeId));
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corruption(treeId, 'head 不是合法 JSON');
    }
    const record = asRecord(parsed, 'head', treeId);
    if (record.version !== STORAGE_VERSION) throw corruption(treeId, 'head 的格式版本不认识');
    if (record.treeId !== treeId) throw corruption(treeId, 'head 记录的树 ID 不匹配');
    if (typeof record.commits !== 'number' || !Number.isSafeInteger(record.commits) || record.commits < 0) {
      throw corruption(treeId, 'head 的提交数无效');
    }
    return { version: STORAGE_VERSION, treeId, commits: record.commits };
  }

  /**
   * 读某棵树的第 seq 条增量；缺失或损坏都抛 storage，不返回半条历史。
   * @param treeId 目标树
   * @param seq 从 1 开始的提交序号
   * @returns 该次提交的增量
   */
  delta(treeId: TreeId, seq: number): JournalDeltaRecord {
    const key = this.deltaKey(treeId, seq);
    const raw = this.storage.getItem(key);
    if (raw === null) throw corruption(treeId, `缺少第 ${seq} 笔提交`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corruption(treeId, `第 ${seq} 笔提交不是合法 JSON`);
    }
    const record = asRecord(parsed, `第 ${seq} 笔提交`, treeId);
    if (record.version !== STORAGE_VERSION) throw corruption(treeId, `第 ${seq} 笔提交的格式版本不认识`);
    if (record.treeId !== treeId || record.seq !== seq) throw corruption(treeId, `第 ${seq} 笔提交的顺序对不上`);
    if (record.mode !== 'existing' && record.mode !== 'createNew') {
      throw corruption(treeId, `第 ${seq} 笔提交的事务模式无效`);
    }
    const nodes = record.nodes;
    const refs = record.refs;
    const revisions = record.revisions;
    if (!Array.isArray(nodes) || !Array.isArray(refs) || !Array.isArray(revisions)) {
      throw corruption(treeId, `第 ${seq} 笔提交缺少 nodes / refs / revisions 数组`);
    }
    return {
      version: STORAGE_VERSION,
      treeId,
      seq,
      mode: record.mode,
      nodes: nodes as CognitionNode[],
      refs: refs as Ref[],
      revisions: revisions as Revision[],
    };
  }

  /**
   * 追加一条已提交事务的增量：先写 delta，再更新 head。
   * 第一次写入用 createNew，head 从 0 开始；之后必须已有 head。
   * @param treeId 目标树
   * @param mode 事务模式，与内核重放时一致
   * @param delta 本次提交的增量
   * @param expectedCommits 调用方内存中的已提交数；给出时先核对 head 是否仍停在该版本
   * @returns 追加后的提交数
   * @throws CognitionError storage：版本已在页面外变化、无法写入或已有版本键（不覆盖历史）
   */
  append(treeId: TreeId, mode: JournalMode, delta: JournalDelta, expectedCommits?: number): number {
    const head = this.head(treeId);
    if (expectedCommits !== undefined && (head?.commits ?? 0) !== expectedCommits) {
      // 页面外写入后本树字节数已不可信；下次统计重新扫描一次，不用旧缓存。
      this.byteCache.delete(treeId);
      throw new CognitionError(
        'storage',
        `测试存储里的 ${treeId} 已在页面外变化（head 是 v${head?.commits ?? 0}，本页停在 v${expectedCommits}）；为避免拼接两个版本，本次未保存。重载页面后再试。`,
      );
    }
    if (mode === 'createNew' && head !== null) {
      throw new CognitionError('storage', `测试存储里已经有 ${treeId}，不覆盖已存在的树`);
    }
    if (mode === 'existing' && head === null) {
      throw new CognitionError('storage', `测试存储里没有 ${treeId} 的 head，无法追加`);
    }
    const seq = (head?.commits ?? 0) + 1;
    const deltaKey = this.deltaKey(treeId, seq);
    const oldHeadRaw = this.storage.getItem(this.headKey(treeId));
    // 版本键不可变：同名键已存在说明状态不一致，宁可失败也不覆盖旧历史。
    if (this.storage.getItem(deltaKey) !== null) {
      throw new CognitionError('storage', `测试存储里 ${treeId} 的第 ${seq} 笔提交已存在，拒绝覆盖`);
    }
    const stored: JournalDeltaRecord = {
      version: STORAGE_VERSION,
      treeId,
      seq,
      mode,
      nodes: delta.nodes,
      refs: delta.refs,
      revisions: delta.revisions,
    };
    let deltaRaw: string;
    try {
      deltaRaw = JSON.stringify(stored);
      this.storage.setItem(deltaKey, deltaRaw);
    } catch (e) {
      throw writeFailure(treeId, '写第 ' + seq + ' 笔提交', e);
    }
    const headKey = this.headKey(treeId);
    const headRaw = JSON.stringify({ version: STORAGE_VERSION, treeId, commits: seq } satisfies JournalHead);
    try {
      this.storage.setItem(headKey, headRaw);
    } catch (e) {
      // head 没写成功，这次提交不算数；删掉刚落下的 delta，避免留下孤儿键。
      try {
        this.storage.removeItem(deltaKey);
      } catch {
        // 清理失败也只是留下一个无人引用的孤儿键，不改变读到的历史。
      }
      throw writeFailure(treeId, '更新 head', e);
    }
    this.rememberAppend(treeId, deltaKey, deltaRaw, headKey, headRaw, oldHeadRaw);
    return seq;
  }

  /**
   * 删掉这棵树在本命名空间的全部键；原型 v1 与其他树的键不动。
   * @param treeId 目标树
   */
  clear(treeId: TreeId): void {
    const keep = this.treePrefix(treeId);
    const doomed: string[] = [];
    for (let i = 0; i < this.storage.length; i += 1) {
      const key = this.storage.key(i);
      if (key !== null && key.startsWith(keep)) doomed.push(key);
    }
    for (const key of doomed) this.storage.removeItem(key);
    this.byteCache.delete(treeId);
  }

  /**
   * 成功提交后按增量维护字节缓存：新增 delta 的键与值；head 是替换值，键不变。
   * 没有缓存时不计算，首次 bytes() 会完整扫描一次。
   * @param treeId 目标树
   * @param deltaKey 新 delta 键
   * @param deltaRaw 新 delta 值的序列化文本
   * @param headKey head 键
   * @param headRaw 新 head 值的序列化文本
   * @param oldHeadRaw 提交前 head 值；首次创建时为 null
   */
  private rememberAppend(
    treeId: TreeId,
    deltaKey: string,
    deltaRaw: string,
    headKey: string,
    headRaw: string,
    oldHeadRaw: string | null,
  ): void {
    const cached = this.byteCache.get(treeId);
    if (cached === undefined) return;
    let next = cached + byteLength(deltaKey) + byteLength(deltaRaw);
    if (oldHeadRaw === null) next += byteLength(headKey) + byteLength(headRaw);
    else next += byteLength(headRaw) - byteLength(oldHeadRaw);
    this.byteCache.set(treeId, next);
  }

  /**
   * 这棵树在测试存储里占用的 UTF-8 字节数（head 与全部 delta 的键+值）；用于开发坞显示真实占用。
   * 只统计本树在本命名空间的键；首次调用扫描一次，之后由成功提交增量维护，render 期间是常数时间。
   * 另有标签页写入时缓存可能滞后，本页会在下次写入冲突或重载后重新统计。
   * @param treeId 目标树
   * @returns 字节数；不存在为 0
   */
  bytes(treeId: TreeId): number {
    const cached = this.byteCache.get(treeId);
    if (cached !== undefined) return cached;
    const keep = this.treePrefix(treeId);
    let total = 0;
    for (let i = 0; i < this.storage.length; i += 1) {
      const key = this.storage.key(i);
      if (key === null || !key.startsWith(keep)) continue;
      total += byteLength(key) + byteLength(this.storage.getItem(key) ?? '');
    }
    this.byteCache.set(treeId, total);
    return total;
  }

  private headKey(treeId: TreeId): string {
    return this.treePrefix(treeId) + 'head';
  }

  private deltaKey(treeId: TreeId, seq: number): string {
    return this.treePrefix(treeId) + 'delta:' + seq;
  }

  private treePrefix(treeId: TreeId): string {
    return this.prefix + ':tree:' + encodeURIComponent(treeId) + ':';
  }
}

/**
 * 把宿主写入异常翻译成内核可分支处理的 storage 错误。
 * @param treeId 目标树
 * @param action 正在做的写入
 * @param cause 宿主抛出的值
 */
function writeFailure(treeId: TreeId, action: string, cause: unknown): CognitionError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new CognitionError('storage', `没能把 ${treeId} 写进测试存储（${action}）：${reason}`);
}

/**
 * 计算字符串的 UTF-8 字节数；开发坞用它显示真实占用。
 * @param text 要计数的文本
 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
