#!/usr/bin/env node
/** 隔离验收：加载构建产物与真实 DSH 注册表、原生 skill 工具、真实树 worker/SQLite。
 * agent/session/workspace 与权限来源为夹具，不启动真实 profile、UI、模型或后台对话。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installHostDoubles, loadSdk, makeFixture, readViewInput } from './check-host/sdk.mjs';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const sdkRoot = process.argv[2] ?? process.env.DSH_SDK_ROOT;
if (!sdkRoot) throw new Error('用法：node cognition-tree/adapters/dsh/scripts/check-autonomy.mjs <DSH 安装根>');
const requireSdk = createRequire(join(resolve(sdkRoot), 'package.json'));
const sdkImport = specifier => import(pathToFileURL(requireSdk.resolve(specifier)).href);
const { Context, Service, SystemPrompt, ToolsService } = await loadSdk(sdkRoot);
const { createScope, scopeTarget } = await sdkImport('@deepseek-ai/dsh-scope');
const { default: SkillRegistry } = await sdkImport('@deepseek-ai/dsh-skill');
const skillPlugin = await sdkImport('@deepseek-ai/dsh-tool-skill');
const treePlugin = await import(new URL('../../../../.local-work/dsh-plugin/lib/index.js', import.meta.url));
const root = new Context();
const fixture = makeFixture(repoRoot);
const signal = new AbortController().signal;
const intro = 'cognition-tree-autonomy';
const maintenance = 'incremental-formalization';
const listName = 'cognition_tree_list_trees';
const disposers = [];

/** 激活并等待真实 Cordis fiber；退出时按逆序解绑。 */
async function mount(plugin, config) {
  const fiber = root.plugin(plugin, config);
  disposers.push(() => fiber.dispose());
  await fiber.await();
  return fiber;
}

/** 发出与 DSH 相同的作用域事件，复用夹具 Session，不伪造运行时权限。 */
async function start(session) {
  // 原生目录由会话记录投影；这些夹具代表没有任何过往目录的新会话。
  Object.assign(session, { seq: 0, surface: { nodes: [] } });
  const agent = { id: session.id, session };
  const scope = createScope(root, agent);
  agent.ctx = scope.ctx;
  const dispatch = scopeTarget(agent, agent);
  await root.serial(dispatch, 'agent/created', { agent, source: 'new', signal });
  const stop = async () => {
    await scope.dispose();
    await root.parallel(dispatch, 'agent/disposed', { agent });
  };
  disposers.push(stop);
  return { agent, stop };
}

/** 使用 Agent 作用域真正查表后调用；不会绕到文件系统工具。 */
function invoke(agent, name, args) {
  const definition = root.get('tools').get(name, agent);
  assert.ok(definition, `未向 ${agent.id} 注册 ${name}`);
  return definition.execute(args, { agent, signal });
}

/** Web 与大模型目录各自依据 invocation filter；这两个技能都须在相同作用域可调用。 */
async function assertCatalog(agent, names) {
  const options = { cwd: agent.session.header.cwd, scope: agent };
  const actual = (await root.get('skills').list(options))
    .filter(skill => skill.provider === 'dsh-cognition-tree' && skill.invocation.modelInvocable && skill.invocation.userInvocable)
    .map(skill => skill.name);
  assert.deepEqual(actual.sort(), [...names].sort());
  const decision = await root.waterfall(scopeTarget(agent, agent), 'agent/pre-step', { agent, messages: [], signal },
    async () => ({ kind: 'enter', messages: [] }));
  const message = decision.messages.find(item => item.source.kind === 'skill-catalog');
  assert.deepEqual((message?.source.entries ?? []).map(entry => entry.name).sort(), [...names].sort());
  if (names.length) assert.match(message.content[0].text, /<available_skills>/u);
}

try {
  await mount({ name: 'autonomy-check-host', apply(ctx) {
    new SystemPrompt(ctx, {});
    new ToolsService(ctx);
    new SkillRegistry(ctx);
    installHostDoubles(ctx, Service, fixture);
    ctx.provide('agents', {});
    ctx.provide('workingDirectory', { ensure: async agent => agent.session.header.cwd });
    ctx.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session === fixture.peerSession ? 'read-only' : 'workspace-write', workspaceRoot: session.header.cwd }),
    });
  } });
  await mount(skillPlugin);
  const defaultPlugin = await mount(treePlugin);
  const neverEnabled = await start(fixture.session);
  await assertCatalog(neverEnabled.agent, []);
  assert.equal(root.get('tools').get(listName, neverEnabled.agent), undefined);
  await neverEnabled.stop();
  await defaultPlugin.dispose();

  const enabledPlugin = await mount(treePlugin, { autonomousWorkspaces: [fixture.workspace] });
  const a = (await start(fixture.session)).agent;
  const peer = await start(fixture.peerSession);
  const b = peer.agent;
  const outside = (await start(fixture.otherSession)).agent;
  await assertCatalog(a, [intro]);
  await assertCatalog(b, [intro]);
  await assertCatalog(outside, []);
  assert.equal(root.get('tools').get(listName, outside), undefined);
  assert.equal(root.get('tools').get(listName), undefined);
  assert.deepEqual(await root.get('skills').list(), []);
  assert.equal(existsSync(join(fixture.workspace, '.converge')), false);
  assert.equal((await invoke(a, 'skill', { name: intro })).provider, 'dsh-cognition-tree');
  await assert.rejects(invoke(a, 'skill', { name: maintenance }), /unknown or no longer available/u);
  await assert.rejects(invoke(outside, 'skill', { name: intro }), /unknown or no longer available/u);
  await assert.rejects(root.get('tools').get(listName, a).execute({}, { agent: outside, signal }), /未启用/u);
  await assert.rejects(invoke(a, 'cognition_tree_read_view', readViewInput('Missing')));
  await assertCatalog(a, [intro]);
  assert.deepEqual(await invoke(a, listName, {}), { trees: [] });
  assert.equal(existsSync(join(fixture.workspace, '.converge')), false);

  const ids = ['Alpha', 'Beta'];
  for (const treeId of ids) {
    assert.equal(await invoke(a, 'cognition_tree_create_tree', { treeId, rootQuestion: `${treeId} 的根问题` }), treeId);
  }
  await assertCatalog(a, [intro, maintenance]);
  const loaded = await invoke(a, 'skill', { name: maintenance });
  assert.equal(loaded.provider, 'dsh-cognition-tree');
  assert.match(loaded.content, /# 随讨论记录判断/u);
  await assertCatalog(b, [intro]);
  await assert.rejects(invoke(b, 'skill', { name: maintenance }), /unknown or no longer available/u);
  const page = await invoke(a, listName, { limit: 1 });
  assert.equal(page.nextAfter, ids[0]);
  assert.equal(page.trees[0].rootQuestion, `${ids[0]} 的根问题`);
  assert.deepEqual(await invoke(a, listName, { limit: 1, after: page.nextAfter }), {
    trees: [{ treeId: ids[1], rootId: ids[1], rootQuestion: `${ids[1]} 的根问题` }],
  });

  // 同一个 agent/信号连续维护两棵树，没有切换命令；每次都要提供自己的树 ID 和版本。
  const view = treeId => invoke(a, 'cognition_tree_read_view', { ...readViewInput(treeId), includeDetails: true });
  for (const treeId of ids) {
    const current = await view(treeId);
    await invoke(a, 'cognition_tree_add_branch', {
      treeId, expectedStamp: current.stamp, placement: { parentId: treeId, kind: 'branch' },
      draft: { body: { title: `${treeId} 的独立判断` }, state: 'keep', refs: [] },
    });
  }
  for (const treeId of ids) {
    const result = await view(treeId);
    assert.equal(result.nodes.length, 2);
    assert.deepEqual(result.nodes.map(row => [row.detail.node.body.title, row.detail.node.confirmation, row.detail.currentChange.by]), [
      [`${treeId} 的根问题`, 'unconfirmed', 'ai'], [`${treeId} 的独立判断`, 'unconfirmed', 'ai'],
    ]);
  }
  await invoke(b, 'cognition_tree_read_view', readViewInput(ids[0]));
  await assertCatalog(b, [intro, maintenance]);
  await assert.rejects(invoke(b, 'cognition_tree_create_tree', { treeId: 'ReadOnly', rootQuestion: '不允许' }), /只读/u);
  await assert.rejects(invoke(b, 'cognition_tree_process', { treeId: ids[0], action: { kind: 'save', text: '不允许' } }), /只读/u);
  await assert.rejects(invoke(outside, 'cognition_tree_read_view', readViewInput(ids[0])), error => error.code === 'missing');
  await assertCatalog(outside, []);
  assert.equal(root.get('tools').get('cognition_tree_confirm', a), undefined);

  await peer.stop();
  await assertCatalog(b, []);
  assert.equal(root.get('tools').get(listName, b), undefined);
  await enabledPlugin.dispose();
  await assertCatalog(a, []);
  assert.equal(root.get('tools').get(listName, a), undefined);
  console.log(`PASS: packaged skills, same-workspace agent isolation, read-only guard, multi-tree SQLite, cleanup (${fixture.runDir})`);
} finally {
  for (const dispose of disposers.reverse()) await dispose();
}
