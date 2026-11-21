/**
 * 工作区树目录的客户端边界：同源 GET、只带可信会话、只读不缓存、失败保留 code。
 * 不渲染 React，也不启动服务。
 */
import { describe, expect, it } from 'vitest';
import { TREES_PATH } from '../src/types/wire';
import { parseTreeDirectory, readTreeDirectory, toDirectoryError } from '../src/client/tree-directory';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** 最小 fetch 替身：按顺序返回给定响应，并记录请求。 */
function fakeFetch(responses: { ok?: boolean; status?: number; text: string }[]) {
  const calls: FetchCall[] = [];
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

const success = {
  ok: true,
  value: {
    trees: [
      { treeId: 'T1', rootId: 'T1', rootQuestion: '第一个问题' },
      { treeId: 'T2', rootId: 'R2', rootQuestion: '第二个问题' },
    ],
    unavailable: ['T3'],
  },
};

describe('目录正文解析', () => {
  it('读取成功信封里的树与不可用 ID', () => {
    expect(parseTreeDirectory(JSON.stringify(success))).toEqual({
      trees: success.value.trees,
      unavailable: ['T3'],
    });
  });

  it('同 ID 只留第一项，空白 ID 丢弃，根问题或根缺失时记为不可用', () => {
    const parsed = parseTreeDirectory(
      JSON.stringify({
        ok: true,
        value: {
          trees: [
            { treeId: 'T1', rootId: 'T1', rootQuestion: '问题' },
            { treeId: 'T1', rootId: 'T9', rootQuestion: '重复项' },
            { treeId: '  ', rootId: 'T2', rootQuestion: '无效' },
            { treeId: 'T2', rootId: 'T2', rootQuestion: '' },
            { treeId: 'T3', rootId: '', rootQuestion: '缺根' },
          ],
          unavailable: ['T4', 'T4', ''],
        },
      }),
    );
    expect(parsed.trees.map((t) => t.treeId)).toEqual(['T1']);
    expect(parsed.unavailable).toEqual(['T2', 'T3', 'T4']);
    // 可点击与不可用互斥：任何 ID 不会同时出现在两边。
    for (const tree of parsed.trees) expect(parsed.unavailable).not.toContain(tree.treeId);
  });

  it('保留旧库里根标识和标题的原文，显示层不能改写点击目标', () => {
    const item = { treeId: 'T2', rootId: ' original-root ', rootQuestion: ' 谁提出了这个问题？ ' };
    expect(parseTreeDirectory(JSON.stringify({ ok: true, value: { trees: [item], unavailable: [] } })).trees).toEqual([item]);
  });

  it('错误信封保留 code 与 message', () => {
    expect(() =>
      parseTreeDirectory(JSON.stringify({ ok: false, error: { code: 'storage', message: '目录读不到。' } })),
    ).toThrow(expect.objectContaining({ code: 'storage', message: '目录读不到。' }));
  });

  it('坏 JSON、成功信封缺 value 或 trees 不是数组都归为 unknown', () => {
    for (const text of ['not json', JSON.stringify({ ok: true }), JSON.stringify({ ok: true, value: { trees: 'x' } })]) {
      expect(() => parseTreeDirectory(text)).toThrow(expect.objectContaining({ code: 'unknown' }));
    }
  });

  it('同一 ID 先以不完整出现、后以完整出现时，以完整项为准且不再列不可用', () => {
    const parsed = parseTreeDirectory(
      JSON.stringify({
        ok: true,
        value: {
          trees: [
            { treeId: 'T2', rootId: '', rootQuestion: '问题' },
            { treeId: 'T2', rootId: 'T2', rootQuestion: '问题' },
          ],
          unavailable: [],
        },
      }),
    );
    expect(parsed.trees).toEqual([{ treeId: 'T2', rootId: 'T2', rootQuestion: '问题' }]);
    expect(parsed.unavailable).toEqual([]);
  });

  it('有候选却一个都辨认不出来时归为形状错误，不伪装成空目录', () => {
    expect(() =>
      parseTreeDirectory(
        JSON.stringify({ ok: true, value: { trees: [{ treeId: '', rootId: 'T1', rootQuestion: 'x' }], unavailable: [] } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'unknown' }));
  });

  it('服务端 unavailable 与 trees 重叠时以可点击项为准，页面不会两处重复', () => {
    const parsed = parseTreeDirectory(
      JSON.stringify({
        ok: true,
        value: {
          trees: [{ treeId: 'T1', rootId: 'T1', rootQuestion: '问题' }],
          unavailable: ['T1', 'T9'],
        },
      }),
    );
    expect(parsed.trees.map((t) => t.treeId)).toEqual(['T1']);
    expect(parsed.unavailable).toEqual(['T9']);
  });

  it('trees 为空但 unavailable 非空仍是可辨认的部分目录', () => {
    expect(parseTreeDirectory(JSON.stringify({ ok: true, value: { trees: [], unavailable: ['T9'] } }))).toEqual({
      trees: [],
      unavailable: ['T9'],
    });
  });
});

describe('目录读取', () => {
  it('同源 GET 只带编码后的 sessionId，不传路径', async () => {
    const { impl, calls } = fakeFetch([{ text: JSON.stringify(success) }]);
    const directory = await readTreeDirectory('session a/b', { fetchImpl: impl });
    expect(directory.trees).toHaveLength(2);
    expect(calls[0]!.url).toBe(TREES_PATH + '?sessionId=session%20a%2Fb');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(calls[0]!.init.cache).toBe('no-store');
    expect(String(calls[0]!.url)).not.toContain('path');
  });

  it('空白会话直接拒绝，不发请求', async () => {
    const { impl, calls } = fakeFetch([{ text: JSON.stringify(success) }]);
    await expect(readTreeDirectory('  ', { fetchImpl: impl })).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it('连接失败与响应不可读都归为 unknown，交给界面重试', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await expect(readTreeDirectory('session-a', { fetchImpl: failing })).rejects.toMatchObject({ code: 'unknown' });
    const broken = (async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('stream');
      },
    })) as unknown as typeof fetch;
    await expect(readTreeDirectory('session-a', { fetchImpl: broken })).rejects.toMatchObject({ code: 'unknown' });
  });

  it('HTTP 状态与成功正文不一致时归为 unknown，不冒充完整目录', async () => {
    const { impl } = fakeFetch([{ ok: false, status: 502, text: JSON.stringify(success) }]);
    await expect(readTreeDirectory('session-a', { fetchImpl: impl })).rejects.toMatchObject({ code: 'unknown' });
  });
});

describe('错误归一', () => {
  it('保留带 code 的错误，未知异常归为 unknown', () => {
    expect(toDirectoryError(Object.assign(new Error('缺树'), { code: 'missing' }))).toEqual({
      code: 'missing',
      message: '缺树',
    });
    expect(toDirectoryError(new Error('坏了'))).toEqual({ code: 'unknown', message: '坏了' });
  });
});
