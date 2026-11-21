/** HTTP/SSE 端口边界：会话必填、写不重试、重连触发读回。 */
import { describe, expect, it } from 'vitest';
import { CALL_PATH } from '../src/types/wire';
import { createCognitionClient, type EventSourceFactory } from '../src/client/transport';

interface CallRecord {
  url: string;
  init: RequestInit;
}

/** 最小 fetch 替身：按顺序返回给定响应文本。 */
function fakeFetch(responses: { ok?: boolean; text: string; status?: number }[]) {
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

/** 最小 EventSource 替身，允许测试手动触发 ready/change/error。 */
function fakeEvents() {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  let closed = false;
  const instances: { url: string; close: () => void; emit: (type: string, data?: unknown) => void }[] = [];
  const factory: EventSourceFactory = (url) => {
    const instance = {
      url,
      close: () => {
        closed = true;
      },
      emit: (type: string, data?: unknown) => {
        const event = { data: JSON.stringify(data) } as MessageEvent;
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
    };
    instances.push(instance);
    return {
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        let set = listeners.get(type);
        if (!set) listeners.set(type, (set = new Set()));
        set.add(listener);
      },
      removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        listeners.get(type)?.delete(listener);
      },
      close: () => {
        closed = true;
        listeners.clear();
      },
    } as unknown as EventSource;
  };
  return { factory, instances, isClosed: () => closed };
}

describe('DSH 认知树 HTTP 端口', () => {
  it('写入带 sessionId/op/input，成功解包 value', async () => {
    const { impl, calls } = fakeFetch([{ text: JSON.stringify({ ok: true, value: 'T1.9' }) }]);
    const client = createCognitionClient({ sessionId: 'session-a', fetchImpl: impl });
    const input = { treeId: 'T1', placement: { kind: 'branch' as const, parentId: 'T1' },
      draft: { state: 'open' as const, body: { title: '新的判断' }, refs: [] } };
    const value = await client.call('addBranch', input);
    expect(value).toBe('T1.9');
    expect(calls[0]!.url).toBe(CALL_PATH);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sessionId: 'session-a', op: 'addBranch', input });
  });

  it('服务端失败保留 code；坏 JSON 归为 unknown', async () => {
    const failure = fakeFetch([
      { text: JSON.stringify({ ok: false, error: { code: 'missing', message: '节点不存在' } }) },
    ]);
    const client = createCognitionClient({ sessionId: 'session-a', fetchImpl: failure.impl });
    await expect(client.call('readNode', { treeId: 'T1', nodeId: 'T1' })).rejects.toMatchObject({ code: 'missing', message: '节点不存在' });

    const broken = fakeFetch([{ text: 'not json' }]);
    const client2 = createCognitionClient({ sessionId: 'session-b', fetchImpl: broken.impl });
    await expect(client2.call('readNode', { treeId: 'T1', nodeId: 'T1' })).rejects.toMatchObject({ code: 'unknown' });
  });

  it('网络失败不重试：一次调用只发一次请求', async () => {
    let attempts = 0;
    const impl = (async () => {
      attempts += 1;
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = createCognitionClient({ sessionId: 'session-a', fetchImpl: impl });
    await expect(client.call('confirm', { treeId: 'T1', target: { seedNodeId: 'T1' } })).rejects.toMatchObject({ code: 'unknown' });
    expect(attempts).toBe(1);
  });

  it('不把 HTTP 失败或缺少 value 的信封报告为提交成功', async () => {
    for (const reply of [{ ok: false, text: '{"ok":true,"value":"T1"}' }, { text: '{"ok":true}' }]) {
      const client = createCognitionClient({ sessionId: 'session-a', fetchImpl: fakeFetch([reply]).impl });
      await expect(client.call('readNode', { treeId: 'T1', nodeId: 'T1' })).rejects.toMatchObject({ code: 'unknown' });
    }
  });

  it('拒绝空会话，不退化到默认工作区', () => {
    expect(() => createCognitionClient({ sessionId: '  ' })).toThrow(/没有当前会话/);
  });
});

describe('DSH 认知树 watch', () => {
  it('首次 ready 和重连 ready 都补读未监听的窗口，change 只转发本树', () => {
    const events = fakeEvents();
    const client = createCognitionClient({ sessionId: 'session-a', eventSource: events.factory });
    const changes: { stamp: number; count: number }[] = [];
    const stop = client.watch('T1', (change) => changes.push({ stamp: change.stamp, count: change.revisions.length }));
    const source = events.instances[0]!;

    source.emit('ready', { sessionId: 'session-a' });
    expect(changes).toEqual([{ stamp: 0, count: 0 }]);
    changes.length = 0;

    source.emit('change', { treeId: 'T2', stamp: 3, revisions: [{ id: 'r1' }] });
    expect(changes).toEqual([]);

    source.emit('change', { treeId: 'T1', stamp: 4, revisions: [{ id: 'r1' }] });
    expect(changes).toEqual([{ stamp: 4, count: 1 }]);

    source.emit('error', {});
    source.emit('ready', { sessionId: 'session-a' });
    expect(changes).toEqual([
      { stamp: 4, count: 1 },
      { stamp: 0, count: 0 },
    ]);

    stop();
    expect(events.isClosed()).toBe(true);
  });

  it('坏 change 不抛给 UI', () => {
    const events = fakeEvents();
    const client = createCognitionClient({ sessionId: 'session-a', eventSource: events.factory });
    const changes: unknown[] = [];
    client.watch('T1', (change) => changes.push(change));
    events.instances[0]!.emit('change', { treeId: 'T1', stamp: 1, revisions: 'nope' });
    expect(changes).toEqual([]);
  });
});
