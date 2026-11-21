/**
 * 内存存储的公开入口。
 *
 * 职责：只转出 MemoryTreeStore 与构造/回调所需的公开类型；存储内部表、索引与事务句柄不对外。
 * 边界：不实现业务规则，也不引入宿主 API；浏览器与内核测试都从这里取内存实现。
 * 协作：浏览器装配用 new MemoryTreeStore({ beforeCommit }) 在发布前保存增量；
 * 内核测试用同一端口验证提交、回滚、版本固定与分批读取。
 */
export { MemoryTreeStore } from './store';
export type { BeforeCommit, MemoryDelta, MemoryTreeStoreOptions } from './types';
