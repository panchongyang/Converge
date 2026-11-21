/**
 * 共用应用壳的公开入口：环境（浏览器、DSH）只从这里拿 App，并按 AppProps 交出端口。
 */
export { App } from './App';
export { TreeDirectory } from '../modules/directory/Directory';
export type { TreeDirectoryProps, DirectoryStatus } from '../modules/directory/Directory';
export type { DirectoryItem } from '../modules/directory/model';
export type { AppProps } from '../types/ports';
