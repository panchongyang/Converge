/**
 * 内核业务错误。
 *
 * 职责：给调用方一个可分支处理的错误码，并携带可直接显示的中文说明。
 * 边界：只区分业务结果，不包装宿主异常、不记录日志；适配器负责把宿主错误翻译成 storage。
 * 协作：commands、queries、models 与端口实现失败时抛 CognitionError，UI 按 code 决定提示方式。
 */
export type ErrorCode =
  /** 目标不存在（树、节点、修订或确认目标）。 */
  | 'missing'
  /** 动作不适用、入口无权、参数不合规，或重复/失效的确认。 */
  | 'invalid'
  /** 保存失败；事务已回滚，原判断、状态、标记与日志都没有半生效。 */
  | 'storage'
  /** 3.2 的读取超限：预算容不下焦点及父链、exact 模式超限，或一项也无法继续推进。 */
  | 'rangeTooLarge'
  /** 续读游标对应的读快照已过期。 */
  | 'viewExpired';

/** 内核抛出的业务错误；message 面向人，可直接显示。 */
export class CognitionError extends Error {
  /** 错误码；调用方据此区分缺失、输入不合规、存储失败和两种读取结果错误。 */
  readonly code: ErrorCode;

  /**
   * 构造一个业务错误。
   * @param code 错误码，调用方据此分支处理
   * @param message 面向人的中文说明
   */
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CognitionError';
    this.code = code;
  }
}
