/**
 * 手稿文本的共用解析原语。
 *
 * 职责：给概览、节点、引用与形成记录的专用解析器提供带行号的错误、唯一小节定位
 * 和顶层分隔符切分。
 * 边界：不认识任何具体字段或业务含义；不读写文件，也不尝试通用 Markdown 解析。
 * 协作：tree / refs / history 各自只用手稿需要的原语；manuscript 负责编排。
 */

/** 手稿翻译失败；message 带原始行号，line 供调用方定位。 */
export class ManuscriptError extends Error {
  /** 出错或无法映射的那一行，1 起算。 */
  readonly line: number;

  /**
   * 记录失败位置与原因。
   * @param line 原始手稿行号，1 起算
   * @param reason 面向人的失败原因
   */
  constructor(line: number, reason: string) {
    super(`认知树手稿第 ${line} 行：${reason}`);
    this.name = 'ManuscriptError';
    this.line = line;
  }
}

/**
 * 找一段唯一的小节标题。
 * @param lines 手稿按行拆分后的全文
 * @param heading 完整标题，例如「## 节点」
 * @returns 标题所在行下标，0 起算
 * @throws ManuscriptError 缺少或重复时
 */
export function uniqueHeadingLine(lines: readonly string[], heading: string): number {
  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === heading) hits.push(index);
  });
  if (hits.length !== 1) {
    throw new ManuscriptError(hits.length > 1 ? hits[1] + 1 : 1, `需要且只能有一个「${heading}」小节`);
  }
  return hits[0];
}

/**
 * 按中文括号与方括号的层级切分，避免把引用说明或括注里的分号切开。
 * @param text 待切分原文
 * @param separator 单字符分隔符
 * @param line 原文行号，1 起算
 * @returns 顶层片段，顺序不变
 */
export function splitTopLevel(text: string, separator: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '（' || char === '[') depth += 1;
    else if (char === '）' || char === ']') depth -= 1;
    if (depth < 0) throw new ManuscriptError(line, `手稿里的括号不配对「${text}」`);
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (depth !== 0) throw new ManuscriptError(line, `手稿里的括号不配对「${text}」`);
  parts.push(current);
  return parts;
}
