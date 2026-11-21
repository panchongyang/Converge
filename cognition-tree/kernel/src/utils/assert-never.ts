/**
 * 穷尽检查。
 *
 * 职责：在 switch 的 default 分支证明联合类型已全部处理。
 * 边界：只用于编译期不可达的位置；命中说明调用方漏了分支，属于编程错误，不是业务错误。
 * 协作：commands 的决定分派与 errors 的错误码处理用它防止新增种类时静默漏掉。
 */

/**
 * 断言值已穷尽；正常路径不会调用，命中即抛错。
 * @param value 已被类型系统收窄为 never 的值
 * @returns 不会返回；总是抛错
 * @throws Error 表示存在未处理的联合类型分支
 */
export function assertNever(value: never): never {
  throw new Error(`未处理的分支：${String(value)}`);
}
