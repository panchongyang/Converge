/**
 * 测试存储日志的用例：重开、增量、写失败、损坏与命名空间隔离。
 *
 * 这里只测持久化层（TreeJournal）本身；TreeStore 的事务与重放另有用例。
 */
import { describe, expect, it } from 'vitest';
import { CognitionError, type CognitionNode, type Revision } from '@cognition-tree/kernel/types';
import { MemoryStorage } from './memory-storage.test-util';
import { TEST_STORAGE_PREFIX, TreeJournal } from './journal';

/** 造一个最小的节点行，只要 ID 可区分。 */
function node(id: string, title = id): CognitionNode {
  return { id, parentId: null, body: { title }, state: 'open', origin: { kind: 'branch' } };
}

/** 造一条导入修订，避免依赖时钟。 */
function revision(id: string, nodeIds: string[]): Revision {
  return {
    id,
    kind: 'formation',
    at: '2026-11-20',
    by: 'import',
    nodeIds,
    summary: '导入 ' + id,
  };
}

/** 第一次提交：创建树与根节点。 */
function firstDelta() {
  return { nodes: [node('T1')], refs: [], revisions: [revision('r1', ['T1'])] };
}

/** 第二次提交：新增一个子节点。 */
function secondDelta() {
  return {
    nodes: [node('T1.1')],
    refs: [
      {
        id: 'ref-1',
        from: 'T1.1',
        kind: 'premise' as const,
        target: { nodeId: 'T1' },
      },
    ],
    revisions: [revision('r2', ['T1.1'])],
  };
}

/** 手工扫描一遍本树键值，作为缓存统计的对照。 */
function scanBytes(storage: MemoryStorage, treeId: string): number {
  const prefix = `${TEST_STORAGE_PREFIX}:tree:${encodeURIComponent(treeId)}:`;
  let total = 0;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    total += new TextEncoder().encode(key).length + new TextEncoder().encode(storage.getItem(key) ?? '').length;
  }
  return total;
}

describe('TreeJournal', () => {
  it('写入两次后按序读回，head 是提交数', () => {
    const storage = new MemoryStorage();
    const journal = new TreeJournal(storage);

    expect(journal.head('T1')).toBeNull();
    expect(journal.append('T1', 'createNew', firstDelta())).toBe(1);
    expect(journal.append('T1', 'existing', secondDelta())).toBe(2);

    expect(journal.head('T1')?.commits).toBe(2);
    const first = journal.delta('T1', 1);
    expect(first.mode).toBe('createNew');
    expect(first.nodes.map((n) => n.id)).toEqual(['T1']);
    const second = journal.delta('T1', 2);
    expect(second.mode).toBe('existing');
    expect(second.nodes.map((n) => n.id)).toEqual(['T1.1']);
    expect(second.refs.map((r) => r.id)).toEqual(['ref-1']);
    expect(second.revisions.map((r) => r.id)).toEqual(['r2']);
  });

  it('日常提交只新增 delta 键并重写小 head，不重写旧历史', () => {
    const storage = new MemoryStorage();
    const journal = new TreeJournal(storage);
    journal.append('T1', 'createNew', firstDelta());
    const firstKey = `${TEST_STORAGE_PREFIX}:tree:T1:delta:1`;
    const firstRaw = storage.getItem(firstKey);

    storage.resetWrites();
    journal.append('T1', 'existing', secondDelta());

    expect(storage.writes.map((w) => w.key)).toEqual([
      `${TEST_STORAGE_PREFIX}:tree:T1:delta:2`,
      `${TEST_STORAGE_PREFIX}:tree:T1:head`,
    ]);
    // 旧 delta 的字节没有变；head 只是小对象。
    expect(storage.getItem(firstKey)).toBe(firstRaw);
    expect(storage.getItem(`${TEST_STORAGE_PREFIX}:tree:T1:head`)).toBe('{"version":1,"treeId":"T1","commits":2}');
  });

  it('拒绝覆盖已有历史或凭空追加', () => {
    const storage = new MemoryStorage();
    const journal = new TreeJournal(storage);
    journal.append('T1', 'createNew', firstDelta());

    expect(() => journal.append('T1', 'createNew', firstDelta())).toThrowError(CognitionError);
    // 目标 delta 键已被占用（例如上次 head 写失败后的孤儿键）：宁可失败也不覆盖旧历史。
    storage.setItem(`${TEST_STORAGE_PREFIX}:tree:T1:delta:2`, '{"orphan":true}');
    expect(() => journal.append('T1', 'existing', firstDelta())).toThrowError(/已存在|拒绝覆盖/);
    expect(() => new TreeJournal(new MemoryStorage()).append('T1', 'existing', firstDelta())).toThrowError(/没有 T1 的 head/);
  });

  it('head 损坏、delta 损坏或缺失都报 storage，不当作空树', () => {
    const base = `${TEST_STORAGE_PREFIX}:tree:T1:`;
    const cases: { name: string; seed: Record<string, string>; treeId: string }[] = [
      { name: 'head 不是 JSON', seed: { [base + 'head']: '{oops' }, treeId: 'T1' },
      {
        name: 'head 版本不认识',
        seed: { [base + 'head']: '{"version":9,"treeId":"T1","commits":1}' },
        treeId: 'T1',
      },
      {
        name: 'delta 缺失',
        seed: { [base + 'head']: '{"version":1,"treeId":"T1","commits":1}' },
        treeId: 'T1',
      },
      {
        name: 'delta 不是 JSON',
        seed: {
          [base + 'head']: '{"version":1,"treeId":"T1","commits":1}',
          [base + 'delta:1']: 'not json',
        },
        treeId: 'T1',
      },
      {
        name: 'delta 缺数组',
        seed: {
          [base + 'head']: '{"version":1,"treeId":"T1","commits":1}',
          [base + 'delta:1']: '{"version":1,"treeId":"T1","seq":1,"mode":"createNew"}',
        },
        treeId: 'T1',
      },
    ];

    for (const c of cases) {
      const journal = new TreeJournal(new MemoryStorage(c.seed));
      const read = () => {
        const head = journal.head(c.treeId);
        for (let seq = 1; seq <= (head?.commits ?? 0); seq += 1) journal.delta(c.treeId, seq);
      };
      expect(read, c.name).toThrowError(CognitionError);
      try {
        read();
      } catch (e) {
        expect((e as CognitionError).code, c.name).toBe('storage');
        expect((e as CognitionError).message, c.name).toMatch(/损坏|缺少/);
      }
    }
  });

  it('head 写失败时回滚新 delta，旧 head 与旧历史保持不变', () => {
    const storage = new MemoryStorage();
    const journal = new TreeJournal(storage);
    journal.append('T1', 'createNew', firstDelta());
    storage.resetWrites();
    storage.failNextWrite((key) => key.endsWith(':head'));

    expect(() => journal.append('T1', 'existing', secondDelta())).toThrowError(/更新 head/);
    expect(journal.head('T1')?.commits).toBe(1);
    expect(storage.getItem(`${TEST_STORAGE_PREFIX}:tree:T1:delta:2`)).toBeNull();
  });

  it('delta 写失败时 head 不动，也不留半条提交', () => {
    const storage = new MemoryStorage();
    const journal = new TreeJournal(storage);
    journal.append('T1', 'createNew', firstDelta());
    storage.failNextWrite((key) => key.endsWith(':delta:2'));

    expect(() => journal.append('T1', 'existing', secondDelta())).toThrowError(/写第 2 笔提交/);
    expect(journal.head('T1')?.commits).toBe(1);
    expect(storage.getItem(`${TEST_STORAGE_PREFIX}:tree:T1:delta:2`)).toBeNull();
  });

  it('清空只移除该树在新命名空间的键，原型 v1 与其他树不动', () => {
    const storage = new MemoryStorage({
      'converge.cognition-tree.proto.v1:T1': '{"legacy":true}',
      'converge.cognition-tree.proto.v1:T2': '{"legacy":true}',
    });
    const journal = new TreeJournal(storage);
    journal.append('T1', 'createNew', firstDelta());
    journal.append('T2', 'createNew', firstDelta());

    journal.clear('T1');

    expect(journal.head('T1')).toBeNull();
    expect(journal.head('T2')?.commits).toBe(1);
    expect(storage.getItem('converge.cognition-tree.proto.v1:T1')).toBe('{"legacy":true}');
    expect(storage.getItem('converge.cognition-tree.proto.v1:T2')).toBe('{"legacy":true}');
  });

  it('存储字节是实际键值长度，随提交增长，不存在时为 0', () => {
    const storage = new MemoryStorage();
    const journal = new TreeJournal(storage);
    expect(journal.bytes('T1')).toBe(0);
    journal.append('T1', 'createNew', firstDelta());
    const afterFirst = journal.bytes('T1');
    expect(afterFirst).toBeGreaterThan(0);
    journal.append('T1', 'existing', secondDelta());
    expect(journal.bytes('T1')).toBeGreaterThan(afterFirst);
    expect(journal.bytes('T2')).toBe(0);
  });

  it('字节统计首次扫描一次，之后按提交增量维护，不重读全部历史', () => {
    const storage = new MemoryStorage();
    const journal = new TreeJournal(storage);
    journal.append('T1', 'createNew', firstDelta());
    const first = journal.bytes('T1');
    expect(first).toBe(scanBytes(storage, 'T1'));

    // 第二次读是缓存命中：不遍历键、不读值。
    storage.resetStats();
    expect(journal.bytes('T1')).toBe(first);
    expect(storage.stats).toEqual({ key: 0, getItem: 0, setItem: 0 });

    // 新提交只按增量更新缓存，统计仍准确；没有为统计重扫历史。
    journal.append('T1', 'existing', secondDelta());
    const expected = scanBytes(storage, 'T1');
    storage.resetStats();
    expect(journal.bytes('T1')).toBe(expected);
    expect(storage.stats).toEqual({ key: 0, getItem: 0, setItem: 0 });
    expect(journal.bytes('T1')).toBeGreaterThan(first);
  });

  it('树 ID 会编码，含冒号或斜杠也不会串键', () => {
    const storage = new MemoryStorage();
    const journal = new TreeJournal(storage);
    journal.append('a:b/c', 'createNew', firstDelta());
    journal.append('a', 'createNew', firstDelta());
    journal.clear('a');
    expect(journal.head('a')).toBeNull();
    expect(journal.head('a:b/c')?.commits).toBe(1);
  });
});
