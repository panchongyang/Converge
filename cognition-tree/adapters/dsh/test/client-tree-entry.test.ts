/**
 * 面板树入口的纯逻辑：树 ID 规则、打开时用 readView(root) 取实际根、创建参数与会话换绑。
 * 只用端口替身，不渲染 React，也不触碰真实工作区。
 */
import { describe, expect, it } from 'vitest';
import type { CognitionClient } from '@cognition-tree/ui/types/ports';
import {
  createAndEnter,
  createTree,
  enterFromDirectory,
  panelMountKey,
  rebindForSession,
  treeIdIssue,
} from '../src/client/tree-entry';

type Call = { op: string; input: Record<string, unknown> };

/** 记录端口调用的替身；handler 决定返回值或抛出业务错误。 */
function fakeClient(handler: (op: string, input: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const client = {
    async call(op: string, input: Record<string, unknown>) {
      calls.push({ op, input });
      return handler(op, input);
    },
    watch() {
      return () => undefined;
    },
  } as unknown as CognitionClient;
  return { client, calls };
}

/** 带 code 的端口错误替身。 */
function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('树 ID 规则（与 storage/files.ts 的数据库文件名一致）', () => {
  it.each([
    ['T1', null],
    ['A', null],
    ['t-1_a', null],
    ['a'.repeat(64), null],
    ['T1', null],
  ])('接受 %s', (id, expected) => {
    expect(treeIdIssue(id)).toBe(expected);
  });

  it.each([
    ['', '不能为空'],
    ['a'.repeat(65), '最长'],
    [' T1', '开头'],
    ['_T1', '开头'],
    ['.T1', '开头'],
    ['树1', '开头'],
    ['T 1', '只能包含'],
    ['T1 ', '只能包含'],
    ['T1.x', '只能包含'],
    ['con', '保留'],
    ['COM1', '保留'],
    ['lpt9', '保留'],
  ])('拒绝 %s', (id, reason) => {
    expect(treeIdIssue(id)).toContain(reason);
  });
});

describe('新建树', () => {
  it('只发 createTree(treeId, rootQuestion)，根问题原文不动', async () => {
    const { client, calls } = fakeClient((op, input) => (op === 'createTree' ? input.treeId : null));
    await expect(createTree(client, 'T2', '  为什么这样定？  ')).resolves.toBe('T2');
    expect(calls).toEqual([{ op: 'createTree', input: { treeId: 'T2', rootQuestion: '  为什么这样定？  ' } }]);
  });

  it('空白根问题与不合规树 ID 都不提交', async () => {
    const { client, calls } = fakeClient(() => 'T2');
    await expect(createTree(client, 'T2', '   ')).rejects.toMatchObject({ code: 'invalid' });
    await expect(createTree(client, 'T 2', '问题')).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it('创建失败后可以再次提交；成功返回树 ID，调用方直接以它为根，无需二次读取', async () => {
    let attempt = 0;
    const { client, calls } = fakeClient(() => {
      if (attempt++ === 0) throw failure('storage', '写入失败。');
      return 'T2';
    });
    await expect(createTree(client, 'T2', '问题')).rejects.toMatchObject({ code: 'storage' });
    await expect(createTree(client, 'T2', '问题')).resolves.toBe('T2');
    expect(calls.map((c) => c.op)).toEqual(['createTree', 'createTree']);
  });

  it('内核拒绝同名树时把原因交给入口显示，不重试也不先删旧树', async () => {
    const { client, calls } = fakeClient(() => {
      throw failure('invalid', '树已存在，不能重复创建。');
    });
    await expect(createTree(client, 'T1', '问题')).rejects.toMatchObject({
      code: 'invalid',
      message: '树已存在，不能重复创建。',
    });
    expect(calls.map((c) => c.op)).toEqual(['createTree']);
  });
});

describe('新建并进入', () => {
  it('创建失败不进入；再次提交成功后直接以树 ID 为根进入，不读根', async () => {
    let fail = true;
    const entered: { treeId: string; rootId: string }[] = [];
    const { client, calls } = fakeClient((_op, input) => {
      if (fail) {
        fail = false;
        throw failure('storage', '写入失败。');
      }
      return input.treeId;
    });
    const enter = (treeId: string, rootId: string) => entered.push({ treeId, rootId });
    await expect(createAndEnter(client, 'T2', '问题', enter)).rejects.toMatchObject({ code: 'storage' });
    expect(entered).toEqual([]);
    await createAndEnter(client, 'T2', '问题', enter);
    expect(entered).toEqual([{ treeId: 'T2', rootId: 'T2' }]);
    expect(calls.map((c) => c.op)).toEqual(['createTree', 'createTree']);
    expect(calls.some((c) => c.op === 'readView')).toBe(false);
  });
});

describe('会话换绑', () => {
  it('换到另一个会话时回到该会话的“全部树”目录，不把上一棵带过去', () => {
    expect(rebindForSession({ sessionId: 'session-a', treeId: 'T9' }, { status: 'ready', sessionId: 'session-b' })).toEqual({
      sessionId: 'session-b',
    });
  });

  it('同一会话不重挂，保留人打开过的树或目录', () => {
    expect(rebindForSession({ sessionId: 'session-a', treeId: 'T9' }, { status: 'ready', sessionId: 'session-a' })).toBeNull();
    expect(rebindForSession({ sessionId: 'session-a' }, { status: 'ready', sessionId: 'session-a' })).toBeNull();
  });

  it('尚未绑定时取唯一实时会话并停在目录；歧义或没有会话时不猜', () => {
    expect(rebindForSession(null, { status: 'ready', sessionId: 'session-a' })).toEqual({ sessionId: 'session-a' });
    expect(rebindForSession(null, { status: 'ambiguous', count: 2 })).toBeNull();
    expect(rebindForSession({ sessionId: 'session-a', treeId: 'T1' }, { status: 'none' })).toBeNull();
  });
});

describe('从目录进入树', () => {
  it('保留 readView 报告的实际根，而不是把树 ID 当根', () => {
    const view = enterFromDirectory({ sessionId: 'session-a' }, 'session-a', 'T9', 'T1');
    expect(view).toMatchObject({ sessionId: 'session-a', treeId: 'T9', initialNodeId: 'T1', refresh: 1 });
  });

  it('同一会话的目录可以进入，refresh 递增让 App 重新读取', () => {
    expect(enterFromDirectory({ sessionId: 'session-a' }, 'session-a', 'T1', 'T1')).toMatchObject({ refresh: 1 });
  });

  it('会话已换、已进入别的树或没有视图时丢弃迟到的打开结果', () => {
    expect(enterFromDirectory({ sessionId: 'session-b' }, 'session-a', 'T9', 'T9')).toBeNull();
    expect(enterFromDirectory({ sessionId: 'session-a', treeId: 'T2' }, 'session-a', 'T9', 'T9')).toBeNull();
    expect(enterFromDirectory(null, 'session-a', 'T1', 'T1')).toBeNull();
  });

  it('不修改原视图对象', () => {
    const current = { sessionId: 'session-a' };
    enterFromDirectory(current, 'session-a', 'T2', 'T2');
    expect(current).toEqual({ sessionId: 'session-a' });
  });
});

describe('重挂键', () => {
  it('同一棵树但 refresh 不同时键不同，保证重新读取', () => {
    const before = { sessionId: 'session-a', treeId: 'T1', initialNodeId: 'T1', refresh: 0 };
    const after = { ...before, refresh: 1 };
    expect(panelMountKey(before)).not.toBe(panelMountKey(after));
  });

  it('跳转序号与视图世代一起决定键，避免复用旧读会话', () => {
    const view = { sessionId: 'session-a', treeId: 'T1' };
    expect(panelMountKey(view, { nodeId: 'T1.1', seq: 1 })).not.toBe(panelMountKey(view, { nodeId: 'T1.1', seq: 2 }));
    expect(panelMountKey(view, null)).toContain(':none');
  });
});
