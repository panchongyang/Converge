/**
 * 兼容出口：check-host 的实现已按职责拆到 ./check-host/ 下的 sdk 与 measure 模块。
 * 新代码直接导入具体模块；保留此处转出，避免已有调用方失效。
 */
export * from './check-host/sdk.mjs';
export * from './check-host/measure.mjs';
