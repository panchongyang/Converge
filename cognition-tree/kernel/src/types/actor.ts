/**
 * 写入口的执行者种类。
 *
 * 职责：区分日常变更的执行者（人或 AI）与修订记录的来源种类（再加导入）。
 * 边界：只记种类、不记显示名；由可信入口识别，不由请求自报。谁执行与谁确认分别记录，
 * 执行者种类本身不表示已获人确认。
 * 协作：node 与 read 的 currentChange 用 DailyActor；Revision.by、PendingTarget.by 和
 * 未确认筛选参数用 RevisionActor。
 */

/**
 * 日常变更的执行者：只有人和 AI 能执行日常变更。
 * 自举导入不是日常变更，不在其中；确认记录另由人发起，不在此列。
 */
export type DailyActor = 'human' | 'ai';

/**
 * 修订记录的来源种类：日常修订取 DailyActor，导入历史另记 import。
 * 新写的确认记录只能是 human；导入手稿记录记 import，并保留原出处。
 */
export type RevisionActor = DailyActor | 'import';
