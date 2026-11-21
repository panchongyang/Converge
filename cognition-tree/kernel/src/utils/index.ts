/**
 * 纯函数工具的公开入口。
 *
 * 职责：统一转出 ID 比较、文本判定、UTF-8 字节计数与穷尽检查。
 * 边界：这里不持有状态、不访问宿主，也不依赖领域类型。
 * 协作：commands、queries 与测试从这里取工具；不要绕过入口引用内部文件。
 */
export { compareIds } from './compare-ids';
export { assertNever } from './assert-never';
export { isNonBlank, utf8ByteLength } from './text';
