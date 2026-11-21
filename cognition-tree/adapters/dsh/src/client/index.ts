/**
 * DSH 认知树插件 · 浏览器半入口。
 *
 * 职责：只做宿主槽位注册，是客户端唯一的副作用点。
 * 入口：
 * - main（keyed cognition-tree）：共享应用壳，无开发坞；
 * - sidebar.panellist：侧栏图标，点击切到主面板；
 * - tool.call.toolview：仅两条 AI 写入工具的卡片，读工具不挂卡；
 * - conversation.session.header.utilities：无可见输出的当前会话探针。
 *
 * 边界：不写 document.head、不注册全局键盘、不 import 服务端运行时代码；
 * React/ReactDOM 由宿主注入，样式字符串由构建期注入并只进 ShadowRoot。
 * 依据：docs/ARCHITECTURE.md §3；wire 见 ../types/wire。
 */
import { createElement } from 'react';
import { AI_TOOLS } from '../types/wire';
import { MainPanel } from './Panel';
import { SessionProbe, SidebarIcon, WriteCard, type ToolCardProps } from './cards-view';
import { PANEL_ID, PANEL_LABEL, type ClientContext } from './host';
import { readWriteCard, cardActionTarget, type ToolBlock, type WriteCardModel } from './cards';

/** 宿主 cordis 依赖：只用槽位与主面板选择。 */
export const inject = ['slots', 'layout'];

/** 图表/写入卡的宿主注入面。 */
export interface CardInjection {
  openPanel: () => void;
}

/**
 * 安装槽位注册。
 * @param ctx 宿主客户端上下文
 */
export function apply(ctx: ClientContext): void {
  /** 切到本插件主面板；宿主未提供 layout 时安静退化。 */
  const openPanel = () => {
    try {
      ctx.layout?.selectPanel(PANEL_ID);
    } catch (error) {
      // 面板未注册时宿主会拒绝；不影响其它入口和已打开的聊天。
    }
  };

  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => createElement(MainPanel)));

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: PANEL_LABEL }, SidebarIcon),
  );

  // 只登记写入工具；key 与 wire 一致，拼错不会渲染，也不会接手别的工具的卡片。
  for (const tool of [AI_TOOLS.addBranch, AI_TOOLS.decideNode]) {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register<ToolCardProps>(
        {
          name: 'tool.call.toolview',
          key: tool,
          inject: () => ({ openPanel }),
        },
        WriteCard,
      ),
    );
  }

  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'cognition-tree-session', order: 200 },
      SessionProbe,
    ),
  );
}

/** 纯逻辑出口，只给单元测试用；不在运行时被宿主读取。 */
export const __test = { readWriteCard, cardActionTarget } as {
  readWriteCard: typeof readWriteCard;
  cardActionTarget: typeof cardActionTarget;
};

export type { ToolBlock, WriteCardModel };
