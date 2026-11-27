/**
 * 归档客户端边界：同源 POST、会话必填、标准信封、列表只收可辨认项、写不重试。
 * 不渲染 React，也不启动服务。
 */
import { describe, expect, it } from 'vitest';
import { ARCHIVE_PATH } from '../src/types/wire';
import { createArchiveAccess } from '../src/client/archive';
import { archiveLanding, archiveTarget, isInSubtree } from '../../../ui/src/modules/archive/model';
import { isVisibilityTransition } from '../../../ui/src/models/useCognition';

interface CallRecord {
  url: string;
  init: RequestInit;
}

/** 最小 fetch 替身：按顺序返回给定响应，并记录请求。 */
function fakeFetch(responses: { ok?: boolean; status?: number; text: string }[]) {
  const calls: CallRecord[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => next.text,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

/** 取出一次请求的 JSON 正文。 */
function bodyOf(call: CallRecord): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const listTree = JSON.stringify({
  ok: true,
  value: [{ treeId: 'T1', title: '已归档的问题' }],
});

describe('归档请求', () => {
  it('列表省略 treeId 只列整树，并带可信会话与同源 POST', async () => {
    const { impl, calls } = fakeFetch([{ text: listTree }]);
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: impl });
    await expect(archive.list()).resolves.toEqual([{ treeId: 'T1', title: '已归档的问题' }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ARCHIVE_PATH);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(bodyOf(calls[0]!)).toEqual({ sessionId: 'session-1', action: 'list' });
  });

  it('列表给 treeId 只查该树的显式分支归档', async () => {
    const { impl, calls } = fakeFetch([{ text: JSON.stringify({ ok: true, value: [] }) }]);
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: impl });
    await expect(archive.list('T1')).resolves.toEqual([]);
    expect(bodyOf(calls[0]!)).toEqual({ sessionId: 'session-1', action: 'list', treeId: 'T1' });
  });

  it('整树归档与整树恢复省略 nodeId', async () => {
    const { impl, calls } = fakeFetch([{ text: '{"ok":true,"value":null}' }]);
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: impl });
    await archive.archive({ treeId: 'T1' });
    await archive.restore({ treeId: 'T1' });

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]!)).toEqual({ sessionId: 'session-1', action: 'archive', treeId: 'T1' });
    expect(bodyOf(calls[1]!)).toEqual({ sessionId: 'session-1', action: 'restore', treeId: 'T1' });
  });

  it('分支归档与恢复带 nodeId，整树定位不混入', async () => {
    const { impl, calls } = fakeFetch([{ text: '{"ok":true,"value":null}' }]);
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: impl });
    await archive.archive({ treeId: 'T1', nodeId: 'n2' });
    await archive.restore({ treeId: 'T1', nodeId: 'n2' });

    expect(bodyOf(calls[0]!)).toEqual({ sessionId: 'session-1', action: 'archive', treeId: 'T1', nodeId: 'n2' });
    expect(bodyOf(calls[1]!)).toEqual({ sessionId: 'session-1', action: 'restore', treeId: 'T1', nodeId: 'n2' });
  });

  it('空 nodeId 按显式空值发送，不退化成整树归档', async () => {
    const { impl, calls } = fakeFetch([{ text: '{"ok":true,"value":null}' }]);
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: impl });
    await archive.archive({ treeId: 'T1', nodeId: '' });
    expect(bodyOf(calls[0]!)).toEqual({ sessionId: 'session-1', action: 'archive', treeId: 'T1', nodeId: '' });
  });

  it('没有会话时不创建端口，避免退化成默认工作区', () => {
    expect(() => createArchiveAccess({ sessionId: '  ' })).toThrowError(/没有当前会话/);
  });
});

describe('归档后的落点', () => {
  /** 只给落点计算需要的两列：id 与真实父节点。 */
  const known = new Map([
    ['n1', { id: 'n1', parentId: null }],
    ['n2', { id: 'n2', parentId: 'n1' }],
    ['n3', { id: 'n3', parentId: 'n2' }],
    ['n4', { id: 'n4', parentId: 'n3' }],
  ]) as unknown as Parameters<typeof archiveLanding>[1];

  it('落到最近的可见祖先，跳过不在视野里的中间节点', () => {
    const visible = new Set(['n1', 'n4']);
    expect(archiveLanding('n4', known, visible, 'n1')).toBe('n1');
    expect(archiveLanding('n3', known, visible, 'n1')).toBe('n1');
  });

  it('没有可见祖先时回到实际根，不用 treeId 代替', () => {
    expect(archiveLanding('n3', known, new Set(['n3']), 'root-of-store')).toBe('root-of-store');
  });

  it('父链缺失时也回到实际根', () => {
    expect(archiveLanding('orphan', known, new Set(['n1']), 'n1')).toBe('n1');
  });

  it('归档定位保留空 nodeId，不退回整树', () => {
    expect(archiveTarget('T1')).toEqual({ treeId: 'T1' });
    expect(archiveTarget('T1', 'n1')).toEqual({ treeId: 'T1', nodeId: 'n1' });
    expect(archiveTarget('T1', '')).toEqual({ treeId: 'T1', nodeId: '' });
  });

  it('子树判断包含祖先自身，并沿真实父链向上找', () => {
    expect(isInSubtree('n4', 'n2', known)).toBe(true);
    expect(isInSubtree('n2', 'n2', known)).toBe(true);
    expect(isInSubtree('n2', 'n4', known)).toBe(false);
    expect(isInSubtree('orphan', 'n1', known)).toBe(false);
  });
});

describe('可见性变化判定', () => {
  const change = (extra: { stamp?: number; visibilityChanged?: true; revisions?: unknown[] }) =>
    ({ treeId: 'T1', stamp: 4, revisions: [], ...extra }) as never;

  it('归档事件即使没有节点 ID 也算可见性变化', () => {
    expect(isVisibilityTransition(change({ visibilityChanged: true }), false)).toBe(true);
  });

  it('归档能力下的重连 ready（stamp 0、空修订）也算', () => {
    expect(isVisibilityTransition(change({ stamp: 0 }), true)).toBe(true);
    expect(isVisibilityTransition(change({ stamp: 0 }), false)).toBe(false);
  });

  it('普通提交与带修订的通知不触发可见性重置', () => {
    expect(isVisibilityTransition(change({ stamp: 5 }), true)).toBe(false);
    expect(isVisibilityTransition(change({ stamp: 0, revisions: [{ id: 'r1' }] }), true)).toBe(false);
  });
});

describe('归档响应', () => {
  it('分支列表只收同树且 nodeId 非空的项，标题缺失留空', async () => {
    const { impl } = fakeFetch([
      {
        text: JSON.stringify({
          ok: true,
          value: [
            { treeId: 'T1', nodeId: 'n1', title: '分支' },
            { treeId: 'T2', nodeId: 'n2', title: '别的树' },
            { treeId: 'T1', nodeId: '  ', title: '空节点' },
            { treeId: 'T1', title: '整树' },
          ],
        }),
      },
    ]);
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: impl });
    await expect(archive.list('T1')).resolves.toEqual([{ treeId: 'T1', nodeId: 'n1', title: '分支' }]);
  });

  it('整树列表只收不带 nodeId 的项，不会把分支当成整树恢复', async () => {
    const { impl } = fakeFetch([
      {
        text: JSON.stringify({
          ok: true,
          value: [
            { treeId: 'T1', nodeId: 'n1', title: '分支' },
            { treeId: 'T2', title: '整树' },
            { treeId: '', title: '无树' },
          ],
        }),
      },
    ]);
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: impl });
    await expect(archive.list()).resolves.toEqual([{ treeId: 'T2', title: '整树' }]);
  });

  it('业务错误保留 code 与说明', async () => {
    const { impl } = fakeFetch([
      { text: '{"ok":false,"error":{"code":"missing","message":"树不存在。"}}', ok: false, status: 404 },
    ]);
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: impl });
    await expect(archive.list()).rejects.toMatchObject({ code: 'missing', message: '树不存在。' });
  });

  it('坏 JSON 与形状不符不冒充空列表', async () => {
    const bad = createArchiveAccess({ sessionId: 'session-1', fetchImpl: fakeFetch([{ text: 'not json' }]).impl });
    await expect(bad.list()).rejects.toMatchObject({ code: 'unknown' });

    const shape = createArchiveAccess({
      sessionId: 'session-1',
      fetchImpl: fakeFetch([{ text: '{"ok":true,"value":{}}' }]).impl,
    });
    await expect(shape.list()).rejects.toMatchObject({ code: 'unknown' });
  });

  it('修改成功必须严格是 null；缺 value 或非 null 都视为形状不符', async () => {
    const ok = createArchiveAccess({ sessionId: 'session-1', fetchImpl: fakeFetch([{ text: '{"ok":true,"value":null}' }]).impl });
    await expect(ok.archive({ treeId: 'T1' })).resolves.toBeUndefined();

    for (const text of ['{"ok":true,"value":[]}', '{"ok":true}']) {
      const bad = createArchiveAccess({ sessionId: 'session-1', fetchImpl: fakeFetch([{ text }]).impl });
      await expect(bad.restore({ treeId: 'T1' })).rejects.toMatchObject({ code: 'unknown' });
    }
  });

  it('网络失败只尝试一次，不自动重试', async () => {
    let count = 0;
    const fail = (async () => {
      count += 1;
      throw new Error('offline');
    }) as typeof fetch;
    const archive = createArchiveAccess({ sessionId: 'session-1', fetchImpl: fail });
    await expect(archive.archive({ treeId: 'T1' })).rejects.toMatchObject({ code: 'unknown' });
    expect(count).toBe(1);
  });
});
