/**
 * 内核契约的唯一公开入口。
 *
 * 职责：把各主题的领域类型、端口与错误统一转出；层外只从这里取内核类型。
 * 边界：这里不实现规则，也不转发宿主 API；各主题文件不另设对外入口。
 * 协作：ui 通过 import type 取契约；kernel 内部模块可直接引用同层主题文件。
 * 依赖方向：ids / actor / node-status / origin / node-body / ref-target / confirm-target
 * 是最底层；ref 只依赖 ids 与 ref-target；node、revision、decision、read 只依赖这些底层
 * 类型文件，互不引用；node-detail、seed、ports 在上层组合。同层无环，与 docs/STRUCTURE.md
 * 的判据一致。
 */
export * from './ids';
export * from './actor';
export * from './node-status';
export * from './origin';
export * from './node-body';
export * from './ref-target';
export * from './ref';
export * from './confirm-target';
export * from './node';
export * from './revision';
export * from './decision';
export * from './node-detail';
export * from './read';
export * from './seed';
export * from './ports';
export * from './errors';
