/** DSH 自主维护接线：从可信工作区启用，借用宿主 agent 作用域发布随包技能和目录工具。
 * 不接管消息驱动或工具写权限；会话不持有当前树，目录可见性不是授权。 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CognitionError } from '@cognition-tree/kernel/types';
import type { AgentSkills, BundledSkill, Dispose, HostAgent, HostContext, ToolExecution } from './abi';
import type { HostRuntime } from './runtime';
import { createListTreesTool, type AutonomyToolHooks } from './tools';

export interface AutonomyConfig {
  /** 宿主注册表中的规范绝对工作区路径白名单。默认空；相邻路径不匹配。 */
  readonly autonomousWorkspaces?: readonly string[];
}

type SkillName = 'cognition-tree-autonomy' | 'incremental-formalization';
type Assets = { intro: BundledSkill; maintenance: BundledSkill };
type Enrollment = {
  readonly root: string;
  readonly skills: AgentSkills;
  readonly assets: Assets;
  readonly disposers: Dispose[];
  maintenance: boolean;
};

/** 只规范化完整路径的拼写，不从进程 cwd 或当前盘符填充缺失部分。 */
function rootKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isAbsolute(value)) return undefined;
  if (process.platform === 'win32' && /^[\\/]$/u.test(parse(value).root)) return undefined;
  return resolve(value);
}

/** 配置错误整组拒绝，而非把坏配置当成全开或部分授权。 */
export function autonomousRoots(config: AutonomyConfig | undefined): ReadonlySet<string> {
  if (config === undefined || config.autonomousWorkspaces === undefined) return new Set();
  const values = config.autonomousWorkspaces;
  if (!Array.isArray(values)) throw new TypeError('autonomousWorkspaces must be an array');
  const roots = new Set<string>();
  for (const value of values) {
    const root = rootKey(value);
    if (!root) throw new TypeError('autonomousWorkspaces requires absolute workspace paths');
    roots.add(root);
  }
  return roots;
}

/** 读取固定随包资源。构建检查约束头为三个单行标量，调用策略由注册决定。 */
async function readSkill(directory: URL, name: SkillName, signal: AbortSignal): Promise<BundledSkill> {
  const path = fileURLToPath(new URL(`${name}/SKILL.md`, directory));
  const raw = (await readFile(path, { encoding: 'utf8', signal })).replace(/\r\n/gu, '\n');
  const match = /^---\n([\s\S]+?)\n---\n([\s\S]+)$/u.exec(raw);
  const metadata = new Map<string, string>();
  for (const line of match?.[1].split('\n') ?? []) {
    const field = /^(name|description|whenToUse): (.+)$/u.exec(line);
    if (!field || metadata.has(field[1])) throw new TypeError('Invalid packaged skill header');
    metadata.set(field[1], field[2].trim());
  }
  const description = metadata.get('description');
  const whenToUse = metadata.get('whenToUse');
  const content = match?.[2].trim();
  if (metadata.get('name') !== name || !description || !whenToUse || !content) throw new TypeError('Invalid packaged skill');
  return { name, description, whenToUse, content, path, provider: 'dsh-cognition-tree', source: 'bundled' };
}

/** 每个插件激活一份。按 agent 对象而非字符串 ID 管理目录；被替换的会话不继承注册。 */
export class Autonomy implements AutonomyToolHooks {
  private readonly active = new Map<HostAgent, Enrollment>();
  private readonly lifetime = new AbortController();
  private readonly listeners: Dispose[] = [];
  private assets?: Promise<Assets>;

  constructor(
    private readonly runtime: HostRuntime,
    private readonly roots: ReadonlySet<string>,
    private readonly assetsDir: URL,
    private readonly warn: (message: string) => void,
  ) {}

  /** 挂载宿主生命周期观察，不拦截消息，也不启动后台或新一轮。 */
  listen(ctx: HostContext): void {
    if (!ctx.on) return;
    this.listeners.push(ctx.on('agent/created', ({ agent, signal }) => this.attach(agent, signal)));
    this.listeners.push(ctx.on('agent/disposed', ({ agent }) => { void this.detach(agent); }));
  }

  /** 仅在启用工作区首次需要时读资产；未启用会话不会触发包读取或树后台。 */
  private loadAssets(): Promise<Assets> {
    return this.assets ??= Promise.all([
      readSkill(this.assetsDir, 'cognition-tree-autonomy', this.lifetime.signal),
      readSkill(this.assetsDir, 'incremental-formalization', this.lifetime.signal),
    ]).then(([intro, maintenance]) => ({ intro, maintenance }));
  }

  /** 从刚装配好的 agent 上借用真正的 scoped services。缺失能力时不回退到全局注册。 */
  private async attach(agent: HostAgent, caller?: AbortSignal): Promise<void> {
    if (this.lifetime.signal.aborted || this.active.has(agent)) return;
    const signal = caller ? AbortSignal.any([caller, this.lifetime.signal]) : this.lifetime.signal;
    try {
      const skills = agent.ctx?.get('skills');
      const tools = agent.ctx?.get('tools');
      if (!skills || !tools) return;
      // 会话没绑定已注册工作区很常见；命中白名单前无需读取任何插件资产。
      const root = await this.runtime.aiWorkspace({ agent, signal }).then(rootKey, () => undefined);
      if (!root || !this.roots.has(root)) return;
      const assets = await this.loadAssets();
      signal.throwIfAborted();
      if (this.active.has(agent)) return;
      const entry: Enrollment = { root, skills, assets, disposers: [], maintenance: false };
      this.active.set(agent, entry);
      try {
        entry.disposers.push(tools.register(createListTreesTool(this.runtime, this)));
        entry.disposers.push(skills.register(assets.intro));
      } catch (error) {
        await this.detach(agent);
        throw error;
      }
    } catch {
      if (!signal.aborted) this.warn('本会话自主维护技能未能装配');
    }
  }

  /** 发现工具执行时再用可信 workspace root 核对，不能只靠目录可见性。 */
  assertEnabled(exec: ToolExecution, root: string): void {
    const entry = exec.agent && this.active.get(exec.agent);
    if (!entry || this.lifetime.signal.aborted || entry.root !== rootKey(root)) {
      throw new CognitionError('invalid', '本会话未启用认知树自主维护。');
    }
  }

  /** 一次受信的成功读树或建树只解锁说明书；不把该次 treeId 保存为默认写入目标。 */
  verifiedTree(exec: ToolExecution, root: string): void {
    const entry = exec.agent && this.active.get(exec.agent);
    if (!entry || entry.maintenance || exec.signal.aborted || this.lifetime.signal.aborted || entry.root !== rootKey(root)) return;
    try {
      entry.disposers.push(entry.skills.register(entry.assets.maintenance));
      entry.maintenance = true;
    } catch {
      this.warn('本会话维护技能未能注册');
    }
  }

  /** 只注销自己的贡献，且先撤销执行许可，不论注册表解绑是否成功。 */
  private async detach(agent: HostAgent): Promise<void> {
    const entry = this.active.get(agent);
    this.active.delete(agent);
    if (entry) await this.drain(entry.disposers.reverse());
  }

  /** 清理三个注册面（目录工具、说明、维护）和生命周期观察。 */
  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.all([
      this.drain(this.listeners.splice(0).reverse()),
      ...[...this.active.keys()].map(agent => this.detach(agent)),
    ]);
  }

  /** 单个清理故障不妨碍其余清理。 */
  private async drain(disposers: readonly Dispose[]): Promise<void> {
    for (const dispose of disposers) {
      try { await dispose(); } catch { this.warn('自主维护注册释放失败'); }
    }
  }
}
