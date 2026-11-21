/**
 * 把端口抛出的错误整理成 UI 能显示的形状（纯计算）。
 * 业务错误带 code（见内核契约 ErrorCode）；其它异常归为 unknown，不冒充业务结论。
 */

export interface UiError {
  /** missing / invalid / storage / rangeTooLarge / viewExpired / unknown */
  code: string;
  message: string;
}

/** 每种错误码对人的含义：说明发生了什么、树有没有被改动。 */
export const ERROR_MEANING: Record<string, string> = {
  missing: '目标不存在。',
  invalid: '这个动作对当前判断不适用，树没有改动。',
  storage: '保存失败，已回滚：原判断与修订日志都没有改动，可以重试。',
  rangeTooLarge: '范围超过本次读取预算：放宽预算、缩小范围，或改用“折叠”续读。',
  viewExpired: '视图所依据的版本已失效，请重新读取。',
  unknown: '发生了意外错误，树是否改动以重新读取的结果为准。',
};

/**
 * 归一化一个异常。
 * @param e 端口或运行时抛出的任意值
 * @returns 带 code 与 message 的错误
 */
export function toUiError(e: unknown): UiError {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return { code: (e as { code: string }).code, message: e instanceof Error ? e.message : String(e) };
  }
  return { code: 'unknown', message: e instanceof Error ? e.message : String(e) };
}
