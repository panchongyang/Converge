/**
 * AI 写入口的宿主文件策略护栏；不创建自己的权限系统或提权流程。
 * 对齐已安装 dsh-tool-fs FsSandboxController 与 dsh-sandbox-policy.resolve({session})：
 * mode/workspaceRoot 是每次调用的可信策略，fs.sandboxMode 只说明文件能力是否宣告受限。
 * 人的 owner UI 不走工具策略。SQLite 目录/数据库/sidecar 的物理安全仍由 storage 守护。
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { CognitionError } from '@cognition-tree/kernel/types';
import type { HostContext, SessionIdentity } from './abi';
import { record } from './input';

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access';
interface ResolvedPolicy { mode: Mode; workspaceRoot: string }

/** 辨认真实 SDK 的封闭模式，不从未知策略推导出可写。@param value 宿主策略值。 */
function mode(value: unknown): value is Mode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

/** 生成不会泄漏本地路径的拒绝；该入口没有提权参数。@param message 面向使用者的护栏说明。 */
function denied(message: string): CognitionError { return new CognitionError('invalid', message); }

/**
 * 用已规范路径判断包含关系，禁止前缀碰撞、跨盘与父目录回退。
 * @param workspaceRoot 宿主 policy 的实际规范根。
 * @param dataDirectory registry 工作区内将由 storage 使用的 .converge 目录。
 */
export function containsDataDirectory(workspaceRoot: string, dataDirectory: string): boolean {
  if (!isAbsolute(workspaceRoot) || !isAbsolute(dataDirectory)) return false;
  const tail = relative(workspaceRoot, dataDirectory);
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
}

/**
 * 解析当次宿主策略；无沙箱的隔离组合不虚构限制，有未知或残缺策略时失败关闭。
 * @param ctx 可信宿主的 get 能力。
 * @param session 执行器绑定的真实 Session，不来自请求。
 */
function resolvePolicy(ctx: HostContext, session: SessionIdentity): ResolvedPolicy | undefined {
  const fs = ctx.get('fs') as { readonly sandboxMode?: unknown } | undefined;
  const declared = fs?.sandboxMode;
  if (declared !== undefined && !mode(declared)) throw denied('宿主文件策略模式未知，认知树 AI 变更未执行。');
  const owner = ctx.get('sandboxPolicy') as { resolve?: (request: { session: SessionIdentity }) => unknown } | undefined;
  if (owner === undefined && declared === undefined) return undefined;
  if (!owner || typeof owner.resolve !== 'function') throw denied('宿主文件能力宣告受限但没有有效策略解析器，认知树 AI 变更未执行。');
  const result = owner.resolve({ session });
  if (!record(result) || !mode(result.mode) || typeof result.workspaceRoot !== 'string' || !isAbsolute(result.workspaceRoot)) {
    throw denied('宿主未返回有效的会话文件策略，认知树 AI 变更未执行。');
  }
  return { mode: result.mode, workspaceRoot: result.workspaceRoot };
}

/**
 * 在后台启动/调用前守 AI create/add/decide 的同一文件权限；只准实际 workspaceRoot 内的数据目录。
 * 不使用 additionalWritableRoots、临时目录或任何自报身份扩大本插件写范围；不请求审批或修改策略。
 * @param ctx 可信宿主能力。
 * @param session 真实执行会话。
 * @param root registry 返回的规范工作区根。
 * @param signal 调用取消；检查中的只读 realpath 不留下文件副作用。
 */
export async function assertAiWriteAllowed(ctx: HostContext, session: SessionIdentity, root: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const policy = resolvePolicy(ctx, session);
  if (policy?.mode === 'read-only') throw denied('宿主会话为只读，认知树 AI 变更未执行；本工具不提供提权入口。');
  if (policy?.mode === 'workspace-write') {
    let actualRoot: string;
    try { actualRoot = await realpath(policy.workspaceRoot); }
    catch { throw denied('无法核实宿主策略的实际工作区根，认知树 AI 变更未执行。'); }
    if (!containsDataDirectory(actualRoot, join(root, '.converge'))) {
      throw denied('认知树数据目录不在本会话允许写入的工作区内，AI 变更未执行。');
    }
  }
  signal.throwIfAborted();
  if (ctx.sessions.get(session.id) !== session) throw denied('工具所属会话已结束，认知树 AI 变更未执行。');
}
