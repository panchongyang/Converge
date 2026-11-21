/**
 * DSH 客户端构建期注入与资源声明。
 *
 * 样式：构建把共享 UI 的 CSS 合成一个字符串（已把 :root 改写成 :host，并处理
 * html/body/#root 边界），面板只把它写进自己的 ShadowRoot。
 * 客户端不把任何手稿、样例或 fixture 编进运行时；建树只经 createTree 的人侧入口。
 * `*.css`：共享 UI 的源文件里有副作用式 CSS import；客户端构建按空模块处理，
 * 类型检查只需放行，不让它们进宿主文档。
 */
declare const __COGNITION_PANEL_CSS__: string;

declare module '*.css';
