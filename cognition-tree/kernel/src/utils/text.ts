/**
 * 文本判定与字节计数。
 *
 * 职责：提供与领域无关、只依赖 ES 标准库的字符串工具。
 * 边界：不访问宿主编码器（TextEncoder 属于宿主 API），不做本地化或换行处理。
 * 协作：commands 用 isNonBlank 校验理由与复活条件；queries 用 utf8ByteLength 计预算。
 */

/**
 * 判断值是否是至少含一个非空白字符的字符串。
 * @param value 待判定的值；可能来自尚未校验的输入
 * @returns 是字符串且 trim 后非空时为 true
 */
export function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 计算文本按 UTF-8 编码后的字节数，不依赖宿主编码器。
 * 中文按 3 字节计，补充平面字符（如 emoji）按 4 字节计，用于预算的最大字节数。
 * @param text 待计数的文本
 * @returns UTF-8 编码的字节数
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}
