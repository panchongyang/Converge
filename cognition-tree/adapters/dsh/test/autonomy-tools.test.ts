/** 自主维护工具的宿主边界测试；不接触 profile、端口或磁盘。 */
import { join, parse, resolve } from 'node:path';
import { CognitionError } from '@cognition-tree/kernel/types';
import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '../src/server/backend/index';
import type { HostContext, HostTool, SessionIdentity, ToolExecution } from '../src/server/host/abi';
import { HostRuntime } from '../src/server/host/runtime';
import { createListTreesTool, LIST_TREES_TOOL, PROCESS_TOOL, registerTools } from '../src/server/host/tools';
import { AI_TOOLS } from '../src/types/wire';

const hostRoot = parse(resolve('.')).root;
const alias = join(hostRoot, 'alias');
const alpha = join(hostRoot, 'alpha');
const beta = join(hostRoot, 'beta');
const row = (treeId: string) => ({ treeId, rootId: `root-${treeId}`, rootQuestion: `Question for ${treeId}` });
const viewArgs = {
  treeId: 'T1', focus: { root: true }, onLimit: 'fold',
  expand: { subtreeDepth: 0, jumpHops: 0, direction: 'out', jumpFrom: 'anchor', afterJumpDepth: 0 },
};
const createArgs = { treeId: 'NewTree', rootQuestion: 'Question' };

function fixture() {
  const tools = new Map<string, HostTool>();
  const session = { id: 'live', header: { cwd: alias } };
  const disabled = { id: 'disabled', header: { cwd: beta } };
  const sessions = new Map<string, SessionIdentity>([[session.id, session], [disabled.id, disabled]]);
  const runBy = (session: SessionIdentity): ToolExecution => ({
    agent: { id: session.id, session }, signal: new AbortController().signal,
  });
  const exec = runBy(session);
  const ctx: HostContext = {
    get: () => undefined,
    sessions: { get: id => sessions.get(id) },
    workspaceRegistry: { resolveByPath: async cwd => cwd === alias ? { path: alpha } : cwd === beta ? { path: beta } : undefined },
    tools: { register(tool) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } },
    inject() {}, effect() {},
  };
  const directory = { trees: [row('T1'), row('T2'), row('T10'), row('T11')], unavailable: ['NotVerified'] };
  const listTrees = vi.fn(async (_root: string) => directory);
  const call = vi.fn(async (_root: string, _actor: string, op: string) => op === 'createTree' ? createArgs.treeId : op);
  const backend: Backend = {
    call: call as Backend['call'], listTrees, archive: async () => null,
    process: async (_root, input) => ({ treeId: input.treeId, processId: 'hash', text: 'text' }),
    watch: () => () => {}, close: async () => {},
  };
  const factory = vi.fn(() => backend);
  const runtime = new HostRuntime(ctx, factory);
  const assertEnabled = vi.fn(async (_exec: ToolExecution, root: string) => {
    if (root !== alpha) throw new CognitionError('invalid', 'Not enabled');
  });
  const tool = createListTreesTool(runtime, { assertEnabled });
  return { assertEnabled, call, ctx, directory, disabled, exec, factory, listTrees, runBy, runtime, session, tool, tools };
}

describe('autonomy tool boundary', () => {
  it('declares and enforces strict optional paging arguments before consulting the host', async () => {
    const { tool, assertEnabled, exec, factory } = fixture();
    expect(tool.name).toBe(LIST_TREES_TOOL);
    expect(tool.parameters).toMatchObject({ type: 'object', required: [], additionalProperties: false });
    expect(Object.keys(tool.parameters.properties!)).toEqual(['limit', 'after']);
    for (const args of [null, [], { root: alpha }, { workspacePath: alpha }, { sessionId: 'live' },
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '2' }, { limit: undefined },
      { after: '' }, { after: '../T1' }, { after: ' T1' }, { after: undefined }, { after: 1 }]) {
      await expect(tool.execute(args, exec)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(assertEnabled).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects disabled and forged sessions before reading any directory', async () => {
    const { tool, disabled, runBy, session, assertEnabled, factory } = fixture();
    const disabledExec = runBy(disabled);
    await expect(tool.execute({}, disabledExec)).rejects.toMatchObject({ code: 'invalid', message: 'Not enabled' });
    expect(assertEnabled).toHaveBeenCalledExactlyOnceWith(disabledExec, beta);
    await expect(tool.execute({}, runBy({ ...session }))).rejects.toMatchObject({ code: 'invalid' });
    expect(assertEnabled).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
  });

  it('awaits the opt-in gate and pages only the trusted workspace directory in natural order', async () => {
    const { tool, directory, listTrees, assertEnabled, exec, factory } = fixture();
    let allow!: () => void;
    const gated = new Promise<void>(resolve => { allow = resolve; });
    assertEnabled.mockReturnValueOnce(gated);
    const first = tool.execute({ limit: 2 }, exec);
    await vi.waitFor(() => expect(assertEnabled).toHaveBeenCalledExactlyOnceWith(exec, alpha));
    expect(factory).not.toHaveBeenCalled();
    allow();
    await expect(first).resolves.toEqual({ trees: [row('T1'), row('T2')], nextAfter: 'T2' });
    expect(listTrees).toHaveBeenCalledExactlyOnceWith(alpha);
    // 翻页间目录变化也能按键续读，而不是依赖上一页末项仍存在。
    directory.trees.splice(1, 1);
    await expect(tool.execute({ after: 'T2' }, exec)).resolves.toEqual({ trees: [row('T10'), row('T11')] });
    await expect(tool.execute({ after: 'T11' }, exec)).resolves.toEqual({ trees: [] });
    directory.trees = Array.from({ length: 103 }, (_, index) => row(`T${index}`));
    await expect(tool.execute({}, exec)).resolves.toEqual({ trees: directory.trees.slice(0, 25), nextAfter: 'T24' });
    await expect(tool.execute({ limit: 100 }, exec)).resolves.toEqual({ trees: directory.trees.slice(0, 100), nextAfter: 'T99' });
    expect(assertEnabled).toHaveBeenCalledTimes(5);
  });

  it('notifies after successful read/create only and never globally registers the directory', async () => {
    const { call, ctx, exec, runtime, tools } = fixture();
    const order: string[] = [];
    call.mockImplementation(async (_root, _actor, op) => { order.push(op); return op; });
    const verifiedTree = vi.fn(() => { order.push('verified'); });
    const dispose = registerTools(ctx, runtime, { verifiedTree });
    expect([...tools.keys()]).toEqual([...Object.values(AI_TOOLS), PROCESS_TOOL]);
    await expect(tools.get(AI_TOOLS.readView)!.execute(viewArgs, exec)).resolves.toBe('readView');
    await expect(tools.get(AI_TOOLS.createTree)!.execute(createArgs, exec)).resolves.toBe('createTree');
    await expect(tools.get(AI_TOOLS.readHistory)!.execute({ treeId: 'T1', limit: 1 }, exec)).resolves.toBe('readHistory');
    expect(order).toEqual(['readView', 'verified', 'createTree', 'verified', 'readHistory']);
    expect(verifiedTree.mock.calls).toEqual([[exec, alpha], [exec, alpha]]);
    dispose();
    expect(tools.size).toBe(0);
  });

  it('does not notify on failed operations, and contains notification failures', async () => {
    const { call, ctx, exec, runtime, tools } = fixture();
    const verifiedTree = vi.fn((): void => { throw new Error('notification failure'); });
    registerTools(ctx, runtime, { verifiedTree });
    const read = tools.get(AI_TOOLS.readView)!;
    const create = tools.get(AI_TOOLS.createTree)!;
    call.mockRejectedValueOnce(new CognitionError('missing', 'No such tree'));
    await expect(read.execute(viewArgs, exec)).rejects.toMatchObject({ code: 'missing' });
    call.mockRejectedValueOnce(new CognitionError('invalid', 'Cannot create tree'));
    await expect(create.execute(createArgs, exec)).rejects.toMatchObject({ code: 'invalid' });
    await expect(create.execute({ ...createArgs, root: alpha }, exec)).rejects.toMatchObject({ code: 'invalid' });
    expect(verifiedTree).not.toHaveBeenCalled();
    await expect(read.execute(viewArgs, exec)).resolves.toBe('readView');
    verifiedTree.mockImplementationOnce(async () => { throw new Error('async notification failure'); });
    await expect(create.execute(createArgs, exec)).resolves.toBe(createArgs.treeId);
    expect(verifiedTree).toHaveBeenCalledTimes(2);
  });
});
