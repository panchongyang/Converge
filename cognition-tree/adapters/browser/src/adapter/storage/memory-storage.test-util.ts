/**
 * 测试替身：内存版 Storage。
 *
 * 用途：Vitest 在 node 环境里没有 localStorage；测试注入这个替身，行为和浏览器一致
 * （键值都是字符串、key 按插入序、删除后长度变化），并额外记录写入以便核对
 * “日常提交不重写旧历史”。不进入网页运行路径。
 */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  /** 每一次成功 setItem 的记录，按发生顺序；测试据此核对写入面。 */
  readonly writes: { key: string; value: string }[] = [];
  /** 读取次数；测试据此核对日常统计没有重扫全部历史。 */
  readonly stats = { key: 0, getItem: 0, setItem: 0 };
  /** 匹配的键在下一次 setItem 时抛错；用于模拟配额或浏览器拒绝写入。 */
  private failOn: ((key: string) => boolean) | null = null;

  /**
   * @param seed 初始键值，便于模拟重开页面、损坏数据或遗留的原型数据
   */
  constructor(seed?: Record<string, string>) {
    if (seed) for (const [key, value] of Object.entries(seed)) this.map.set(key, value);
  }

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    this.stats.getItem += 1;
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    this.stats.key += 1;
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.stats.setItem += 1;
    if (this.failOn?.(key)) {
      this.failOn = null;
      throw new DOMException('模拟写入失败', 'QuotaExceededError');
    }
    this.map.set(key, value);
    this.writes.push({ key, value });
  }

  /**
   * 让第一个匹配的键在下一次写入时失败；只生效一次。
   * @param predicate 判断键是否应失败
   */
  failNextWrite(predicate: (key: string) => boolean): void {
    this.failOn = predicate;
  }

  /** 清空写入记录，便于分别统计某一次提交。 */
  resetWrites(): void {
    this.writes.length = 0;
  }

  /** 清空读取/写入计数，便于断言某段操作没有重扫历史。 */
  resetStats(): void {
    this.stats.key = 0;
    this.stats.getItem = 0;
    this.stats.setItem = 0;
  }
}
