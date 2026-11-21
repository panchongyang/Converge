/** 当前会话与跳转信箱的边界：只认宿主给的 ID，多会话时不猜，跳转不跨会话。 */
import { describe, expect, it } from 'vitest';
import { JumpChannel, SessionChannel, initialBinding, normalizeId, type SessionState } from '../src/client/session';

describe('当前会话通道', () => {
  it('按来源汇总：一个来源为 ready，两个不同来源为 ambiguous，撤销后回到 none', () => {
    const channel = new SessionChannel();
    const seen: SessionState[] = [];
    const stop = channel.subscribe((state) => seen.push(state));
    channel.attach('left-header', 'session-a');
    channel.attach('right-header', 'session-a');
    expect(channel.get()).toEqual({ status: 'ready', sessionId: 'session-a' });
    channel.attach('right-header', 'session-b');
    expect(channel.get()).toEqual({ status: 'ambiguous', count: 2 });
    channel.detach('right-header');
    expect(channel.get()).toEqual({ status: 'ready', sessionId: 'session-a' });
    channel.detach('left-header');
    expect(channel.get()).toEqual({ status: 'none' });
    stop();
    channel.attach('late', 'session-c');
    expect(seen).toEqual([
      { status: 'ready', sessionId: 'session-a' },
      { status: 'ambiguous', count: 2 },
      { status: 'ready', sessionId: 'session-a' },
      { status: 'none' },
    ]);
  });

  it('空白来源视为没有会话；normalizeId 不接受非字符串', () => {
    const channel = new SessionChannel();
    channel.attach('header', '  ');
    expect(channel.get()).toEqual({ status: 'none' });
    expect(normalizeId('T1')).toBe('T1');
    expect(normalizeId(' ')).toBeNull();
    expect(normalizeId(7)).toBeNull();
    expect(normalizeId(undefined)).toBeNull();
  });
});

describe('本次打开绑定', () => {
  const ready: SessionState = { status: 'ready', sessionId: 'session-a' };
  const ambiguous: SessionState = { status: 'ambiguous', count: 2 };

  it('卡片跳转优先，其次唯一实时会话；唯一会话只开目录，不默认任何树', () => {
    const jumps = new JumpChannel();
    const pending = jumps.request('session-x', 'T2', 'N1');
    expect(initialBinding(ready, pending)).toEqual({ sessionId: 'session-x', treeId: 'T2' });
    expect(initialBinding(ready, null)).toEqual({ sessionId: 'session-a' });
    expect(initialBinding(ambiguous, null)).toBeNull();
    expect(initialBinding({ status: 'none' }, null)).toBeNull();
  });

  it('无会话但有历史项不会默认绑定（历史只能由人显式选择）', () => {
    const channel = new SessionChannel();
    channel.attach('header', 'session-old');
    channel.detach('header');
    expect(channel.recentSessions()).toEqual(['session-old']);
    expect(channel.get()).toEqual({ status: 'none' });
    expect(initialBinding(channel.get(), null)).toBeNull();
  });

  it('最近会话去重并保留最新在前', () => {
    const channel = new SessionChannel();
    channel.attach('h1', 'session-a');
    channel.attach('h2', 'session-b');
    channel.attach('h1', 'session-a');
    expect(channel.recentSessions()).toEqual(['session-a', 'session-b']);
  });
});

describe('跳转信箱', () => {
  it('只把匹配当前会话与树的意图交给面板', () => {
    const jumps = new JumpChannel();
    jumps.request('session-a', 'T1', 'T1.2.2');
    expect(jumps.peek('session-b', 'T1')).toBeNull();
    expect(jumps.peek('session-a', 'T2')).toBeNull();
    expect(jumps.peek('session-a', 'T1')?.nodeId).toBe('T1.2.2');
    expect(jumps.current()?.sessionId).toBe('session-a');
  });

  it('消费旧意图不会清掉新点击，序号用于订阅方重挂', () => {
    const jumps = new JumpChannel();
    const seen: number[] = [];
    jumps.subscribe((intent) => seen.push(intent.seq));
    const first = jumps.request('session-a', 'T1', 'T1.1');
    const second = jumps.request('session-a', 'T1', 'T1.2');
    expect(second.seq).toBe(first.seq + 1);
    jumps.consume(first);
    expect(jumps.peek('session-a', 'T1')?.nodeId).toBe('T1.2');
    jumps.consume(second);
    expect(jumps.peek('session-a', 'T1')).toBeNull();
    expect(seen).toEqual([first.seq, second.seq]);
  });
});
