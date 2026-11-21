/**
 * 稳定 ID 的纯计算：自然序比较与确定性哈希。不依赖 DOM 或 React。
 */

/**
 * 按稳定 ID 的自然序比较：按“.”分段，数字段按数值比，T1.2.10 排在 T1.2.9 之后。
 * @param a 左侧 ID
 * @param b 右侧 ID
 * @returns 负数表示 a 在前，正数表示 b 在前
 */
export function compareIds(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const da = /^\d+$/.test(sa);
    const db = /^\d+$/.test(sb);
    if (da && db) {
      const d = Number(sa) - Number(sb);
      if (d !== 0) return d;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 把字符串稳定地映射到 [0, 1)。同一 ID 每次结果相同，用于布局抖动和动画相位，
 * 让“有机感”不以随机换取：刷新后节点不会乱跳。
 * @param s 输入字符串（通常是节点 ID）
 */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100003) / 100003;
}
