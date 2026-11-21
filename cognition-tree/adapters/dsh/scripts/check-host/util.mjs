/** 检查内共用的断言与错误格式化；不改变进程状态。 */

/** 断言辅助；失败由 check() 收敛为一条失败记录。 */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 失败信息只保留消息与截断 stack，避免把噪声或不相关路径铺满报告。 */
export function formatError(error) {
  if (error instanceof Error) {
    const stack = (error.stack ?? '').split('\n').slice(1, 3).join(' | ');
    return stack ? `${error.message} [${stack}]` : error.message;
  }
  return String(error);
}
