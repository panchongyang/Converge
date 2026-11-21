/**
 * 内存存储的持久有序映射（treap）。
 *
 * 职责：为子节点、出/入向引用、时间线与未确认索引提供按键 seek 的排序容器；
 * 每次写入只复制从根到命中节点的路径，旧快照仍持有旧根，因此固定版本不需要整表复制。
 * 边界：只依赖 ES 标准库与调用方给的比较函数，不认识节点、修订或树。
 * 协作：indexes 与 unconfirmed 用 set/delete 维护索引；snapshot 用 entriesFrom /
 * entriesBefore 从游标键开始分批读取，不扫描整表。
 */

/** 比较两个索引键：负数表示左键在前，正数表示右键在前，0 表示相同。 */
export type Comparator<K> = (left: K, right: K) => number;

/** 索引项；迭代器只暴露键和值，内部树节点还带优先级与子树指针。 */
export interface OrderedEntry<K, V> {
  readonly key: K;
  readonly value: V;
}

/** 不可变树节点：所有写入都返回新节点，旧版本继续可读。 */
interface EntryNode<K, V> {
  readonly key: K;
  readonly value: V;
  readonly priority: number;
  readonly left: EntryNode<K, V> | null;
  readonly right: EntryNode<K, V> | null;
}

/**
 * 由键文本得到稳定的优先级，使 treap 的期望深度为对数级，也让测试结果可复现。
 * @param key 索引键；只用于生成优先级，不参与语义比较
 * @returns 32 位无符号优先级
 */
function priorityOf(key: unknown): number {
  const text = JSON.stringify(key) ?? '';
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 向树中插入或替换一个键值，并做 treap 旋转保持堆序。
 * @param root 原子树根；可为空
 * @param key 索引键
 * @param value 键对应的值
 * @param priority 新键的优先级；键已存在时沿用旧优先级
 * @param compare 键比较函数
 * @returns 新的树根
 */
function insertNode<K, V>(
  root: EntryNode<K, V> | null,
  key: K,
  value: V,
  priority: number,
  compare: Comparator<K>,
): EntryNode<K, V> {
  if (root === null) {
    return { key, value, priority, left: null, right: null };
  }
  const order = compare(key, root.key);
  if (order === 0) {
    // 替换值但保留原优先级与子树形状，旧根继续保留旧值。
    return { ...root, value };
  }
  if (order < 0) {
    const left = insertNode(root.left, key, value, priority, compare);
    const next: EntryNode<K, V> = { ...root, left };
    return left.priority < next.priority ? rotateRight(next) : next;
  }
  const right = insertNode(root.right, key, value, priority, compare);
  const next: EntryNode<K, V> = { ...root, right };
  return right.priority < next.priority ? rotateLeft(next) : next;
}

/**
 * 右旋：左孩子上移，返回新的子树根。
 * @param root 需要旋转的子树根
 * @returns 旋转后的子树根
 */
function rotateRight<K, V>(root: EntryNode<K, V>): EntryNode<K, V> {
  const pivot = root.left;
  if (pivot === null) return root;
  return { ...pivot, right: { ...root, left: pivot.right } };
}

/**
 * 左旋：右孩子上移，返回新的子树根。
 * @param root 需要旋转的子树根
 * @returns 旋转后的子树根
 */
function rotateLeft<K, V>(root: EntryNode<K, V>): EntryNode<K, V> {
  const pivot = root.right;
  if (pivot === null) return root;
  return { ...pivot, left: { ...root, right: pivot.left } };
}

/**
 * 合并两棵所有键都小于另一棵的树，按优先级选择根。
 * @param left 较小键的子树
 * @param right 较大键的子树
 * @param compare 键比较函数
 * @returns 合并后的树根
 */
function mergeNodes<K, V>(
  left: EntryNode<K, V> | null,
  right: EntryNode<K, V> | null,
  compare: Comparator<K>,
): EntryNode<K, V> | null {
  if (left === null) return right;
  if (right === null) return left;
  if (left.priority < right.priority) {
    return { ...left, right: mergeNodes(left.right, right, compare) };
  }
  return { ...right, left: mergeNodes(left, right.left, compare) };
}

/**
 * 按键删除一个索引项；未命中时返回原树。
 * @param root 原子树根
 * @param key 要删除的键
 * @param compare 键比较函数
 * @returns 新的树根；可能为空
 */
function removeNode<K, V>(
  root: EntryNode<K, V> | null,
  key: K,
  compare: Comparator<K>,
): EntryNode<K, V> | null {
  if (root === null) return null;
  const order = compare(key, root.key);
  if (order < 0) {
    const left = removeNode(root.left, key, compare);
    return left === root.left ? root : { ...root, left };
  }
  if (order > 0) {
    const right = removeNode(root.right, key, compare);
    return right === root.right ? root : { ...root, right };
  }
  return mergeNodes(root.left, root.right, compare);
}

/**
 * 从 start 起按键升序迭代；每个 yield 只推进栈，不预先展开子树。
 * @param root 树根
 * @param compare 键比较函数
 * @param start 起始键
 * @param inclusive start 本身是否包含
 * @returns 索引项的惰性迭代器
 */
function* iterateFrom<K, V>(
  root: EntryNode<K, V> | null,
  compare: Comparator<K>,
  start: K,
  inclusive: boolean,
): IterableIterator<OrderedEntry<K, V>> {
  const stack: EntryNode<K, V>[] = [];
  let node = root;
  while (node !== null) {
    const order = compare(node.key, start);
    if (order < 0 || (order === 0 && !inclusive)) {
      node = node.right;
    } else {
      stack.push(node);
      node = node.left;
    }
  }
  while (stack.length > 0) {
    const entry = stack.pop() as EntryNode<K, V>;
    yield entry;
    let next = entry.right;
    while (next !== null) {
      stack.push(next);
      next = next.left;
    }
  }
}

/**
 * 从 before 之前（严格小于）按键降序迭代；before 为 null 时从最大键开始。
 * @param root 树根
 * @param compare 键比较函数
 * @param before 上界键，不含；null 表示没有上界
 * @returns 索引项的惰性迭代器
 */
function* iterateBefore<K, V>(
  root: EntryNode<K, V> | null,
  compare: Comparator<K>,
  before: K | null,
): IterableIterator<OrderedEntry<K, V>> {
  const stack: EntryNode<K, V>[] = [];
  let node = root;
  if (before === null) {
    while (node !== null) {
      stack.push(node);
      node = node.right;
    }
  } else {
    while (node !== null) {
      if (compare(node.key, before) < 0) {
        stack.push(node);
        node = node.right;
      } else {
        node = node.left;
      }
    }
  }
  while (stack.length > 0) {
    const entry = stack.pop() as EntryNode<K, V>;
    yield entry;
    let next = entry.left;
    while (next !== null) {
      stack.push(next);
      next = next.right;
    }
  }
}

/**
 * 持久有序映射：值不变式由调用方保证，映射自身不复制值。
 * 同一个旧实例在写入后仍返回写入前的键值，供固定版本快照读取。
 */
export class OrderedMap<K, V> {
  /**
   * 创建映射；一般用 empty，只有内部派生实例直接调用。
   * @param compare 键比较函数
   * @param root 当前树根
   */
  private constructor(
    private readonly compare: Comparator<K>,
    private readonly root: EntryNode<K, V> | null,
  ) {}

  /**
   * 创建空映射。
   * @param compare 键比较函数，决定 seek 与遍历顺序
   * @returns 空映射
   */
  static empty<K, V>(compare: Comparator<K>): OrderedMap<K, V> {
    return new OrderedMap(compare, null);
  }

  /**
   * 写入或替换一个键值。
   * @param key 索引键
   * @param value 键对应的值
   * @returns 包含该键值的新映射；原映射不变
   */
  set(key: K, value: V): OrderedMap<K, V> {
    return new OrderedMap(
      this.compare,
      insertNode(this.root, key, value, priorityOf(key), this.compare),
    );
  }

  /**
   * 删除一个键；键不存在时返回原映射。
   * @param key 要删除的键
   * @returns 删除后的新映射
   */
  delete(key: K): OrderedMap<K, V> {
    const next = removeNode(this.root, key, this.compare);
    return next === this.root ? this : new OrderedMap(this.compare, next);
  }

  /**
   * 按键取一个值。
   * @param key 索引键
   * @returns 对应的值；不存在时为 undefined
   */
  get(key: K): V | undefined {
    let node = this.root;
    while (node !== null) {
      const order = this.compare(key, node.key);
      if (order === 0) return node.value;
      node = order < 0 ? node.left : node.right;
    }
    return undefined;
  }

  /**
   * 从起始键升序迭代，供按稳定键分批读取。
   * @param key 起始键
   * @param inclusive 是否包含起始键本身；续读传 false
   * @returns 索引项的惰性迭代器
   */
  entriesFrom(key: K, inclusive = true): IterableIterator<OrderedEntry<K, V>> {
    return iterateFrom(this.root, this.compare, key, inclusive);
  }

  /**
   * 从上界键之前降序迭代，供“从新到旧”的时间线读取。
   * @param key 上界键，不含；null 从最大键开始
   * @returns 索引项的惰性迭代器
   */
  entriesBefore(key: K | null): IterableIterator<OrderedEntry<K, V>> {
    return iterateBefore(this.root, this.compare, key);
  }
}
