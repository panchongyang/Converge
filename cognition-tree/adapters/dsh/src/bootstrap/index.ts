/**
 * DSH 侧的 T1 一次性自举入口。
 *
 * 职责：把构建器以 ?raw 编译进来的仓库手稿原文交给一次性翻译器，返回可交给
 * bootstrapTree 的 SeedTree。
 * 边界：只读仓库手稿，不读写正式存储、不读浏览器已有数据；导入必须由人在面板明确触发。
 * 协作：DSH 客户端把它接到 App 的 bootstrap.seed；点击后内核 bootstrapTree 一次事务创建 T1。
 */
import type { SeedTree } from '@cognition-tree/kernel/types';
import manuscript from '../../../../../认知树.md?raw';
import { translateT1Manuscript } from './manuscript';

/**
 * 生成 T1 一次性导入的种子。
 * @returns 从当前仓库手稿译出的 SeedTree；每次调用重新解析并返回独立对象
 * @throws Error 手稿排版、字段或形成记录无法可靠映射时，带原始行号
 */
export function createT1Seed(): SeedTree {
  return translateT1Manuscript(manuscript);
}
