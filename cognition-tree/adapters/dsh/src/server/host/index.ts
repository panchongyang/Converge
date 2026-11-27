/**
 * DSH Cordis 服务端插件入口：exports {name, inject, apply}，打包为 dsh-cognition-tree/lib/index.js。
 * 状态在 HostRuntime；后台动态加载，具名工具与认证 exact 路由仅增强宿主。
 * 边界依据：docs/design/kernel-interfaces.md §3.1/3.3。没有消息拦截器、独立服务、profile 写入或工具代理人确认。
 */
import type { HostContext } from './abi';
import { HostRuntime, type BackendFactory } from './runtime';
import { registerTools } from './tools';
import { registerRoutes } from './routes';

export const name = 'cognition-tree';
export const inject = ['tools', 'sessions', 'workspaceRegistry'];

/** 后台装配本身也延迟；插件激活与无关会话事件不会加载 SQLite 或创建 worker。 */
async function loadBackend() {
  const { createBackend } = await import('../backend/index');
  return createBackend();
}

/** 不记录原始异常/路径/请求正文；日志只指出本插件降级。@param ctx 宿主日志接口。@param phase 失败阶段。 */
function warn(ctx: HostContext, phase: string): void {
  try { ctx.logger?.warn(`[cognition-tree] ${phase}；其它宿主能力不受影响。`); } catch { /* logger 不属于插件事实提交。 */ }
}

/**
 * 供入口与隔离测试装配；factory 只能来自可信代码，不是插件配置或请求参数。
 * @param ctx 已满足 inject 的宿主上下文。
 * @param factory 测试可替换为隔离后台；生产使用动态加载的 worker 装配。
 * @returns 本插件生命周期，供隔离测试明确排空；生产由 Cordis effect 释放。
 */
export function installHost(ctx: HostContext, factory: BackendFactory = loadBackend): HostRuntime {
  const runtime = new HostRuntime(ctx, factory);
  let offTools = () => {};
  try { offTools = registerTools(ctx, runtime); }
  catch { warn(ctx, '工具注册失败，已回滚自身工具'); }

  try {
    // Connection 可选：headless 只有 AI 工具。注入依赖替换时，子 effect 移除旧路由和旧流。
    ctx.inject(['connection'], routeCtx => {
      try {
        runtime.assertActive();
        const offRoutes = registerRoutes(routeCtx, runtime);
        routeCtx.effect(() => offRoutes, 'cognition-tree authenticated routes');
      } catch { warn(ctx, '人侧路由不可用，未替换宿主路由'); }
    });
    ctx.effect(() => async () => {
      offTools();
      try { await runtime.close(); } catch { warn(ctx, '后台释放失败'); }
    }, 'cognition-tree drain and close');
  } catch {
    offTools();
    void runtime.close().catch(() => warn(ctx, '后台释放失败'));
    warn(ctx, '生命周期装配失败，已停止自身工作');
  }
  return runtime;
}

/** Cordis 标准插件激活；不接受路径或自定义身份配置。@param ctx 可信宿主 Context。 */
export function apply(ctx: HostContext): void { installHost(ctx); }
