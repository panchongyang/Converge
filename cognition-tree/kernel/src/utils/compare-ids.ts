/**
 * 稳定 ID 的排序比较。
 *
 * 职责：按自然序比较树 ID、节点 ID 与引用 ID，供列表排序与分页推进。
 * 边界：只看字符串本身，不查树、不依赖 locale，也不提供整表排序。
 * 协作：存储适配器按索引取行后用它稳定排序；查询按同一顺序分页，避免漏行或重复。
 */

/**
 * 按自然序比较两个稳定 ID：数字串按数值比较，其余按码点字典序；前缀在前。
 * 因此 T1.2.9 排在 T1.2.10 之前，T1.2 排在 T1.2.1 之前。
 * @param left 左侧 ID
 * @param right 右侧 ID
 * @returns 负数表示 left 在前，正数表示 right 在前，0 表示两者相同
 */
export function compareIds(left: string, right: string): number {
  // 拆成“数字串 / 非数字串”交替的片段，使数字段按数值而非字典序比较。
  const leftParts = left.split(/(\d+)/);
  const rightParts = right.split(/(\d+)/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (/^\d+$/.test(leftPart) && /^\d+$/.test(rightPart)) {
      // 先比位数再比字典序，等价于按非负整数比较，且不受超大数字或安全整数上限影响。
      const digitDifference = leftPart.length - rightPart.length;
      if (digitDifference !== 0) return digitDifference;
      return leftPart < rightPart ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
