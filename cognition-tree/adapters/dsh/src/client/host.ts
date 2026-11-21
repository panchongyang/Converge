/**
 * 已安装 DSH 0.2.2-rc.1 客户端槽位的最小结构契约。
 *
 * 职责：只描述本插件注册用到的两个宿主服务面（slots、layout）和入口标识。
 * 边界：不加载宿主 SDK，不把宿主内部形状带进共享 UI；真正的注册调用集中在 index.ts。
 * 依据：宿主 web 前端把 `react` 与 `react-dom` 作为 static module 注入，
 * 槽位 API 与 ProjectBoard 插件的 usage 一致：`slots.inject(name, setup)` 在槽位存在时
 * 调用 setup，setup 内用 `slots.register(descriptor, component)` 返回卸载函数。
 */
import type { ReactNode } from 'react';

/** 本插件在宿主里的稳定标识：主面板 key、侧栏面板 id 与跳转目标都用它。 */
export const PANEL_ID = 'cognition-tree';

/** 侧栏与主面板共用的中文名；不写进宿主 locale，避免改宿主词条。 */
export const PANEL_LABEL = '认知树';

/** 一个槽位注册描述；只有用到的字段，未用字段由宿主忽略。 */
export interface SlotDescriptor {
  /** 槽位名，例如 main、sidebar.panellist、tool.call.toolview。 */
  name: string;
  /** keyed 槽位的键；main 用面板 id，toolview 用工具名。 */
  key?: string;
  /** list 槽位的稳定 id。 */
  id?: string;
  /** 侧栏行顺序。 */
  order?: number;
  /** 侧栏行标题。 */
  label?: string;
  /** 注入面：宿主在渲染时把返回值并入组件 props。 */
  inject?: () => Record<string, unknown>;
}

/** 宿主槽位服务面。 */
export interface SlotsApi {
  /**
   * 在某个槽位有渲染者时安装一次注册。
   * @param name 槽位名
   * @param setup 安装回调，返回注销函数
   */
  inject(name: string, setup: () => (() => void) | void): unknown;
  /**
   * 注册一个槽位占位组件。
   * @param descriptor 槽位名与 key/id/顺序/标题
   * @param component 接收宿主 owner props 与注入面的 React 组件
   * @returns 注销函数
   */
  register<P>(descriptor: SlotDescriptor, component: (props: P) => ReactNode): () => void;
}

/** 宿主布局服务面：只用到选中主面板。 */
export interface LayoutApi {
  /**
   * 切到已注册的主面板。
   * @param panelId 主面板 key
   */
  selectPanel(panelId: string): unknown;
}

/** 客户端插件的 apply 上下文；其余宿主服务不读取。 */
export interface ClientContext {
  slots: SlotsApi;
  layout?: LayoutApi;
}
