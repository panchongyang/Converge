import { describe, expect, it } from 'vitest';
import type {
  CognitionNode,
  ConfirmTarget,
  PendingTarget,
  ReadSnapshot,
  Revision,
  RevisionActor,
} from '../src/types';
import { CognitionError } from '../src/types';
import { MemoryTreeStore } from '../src/storage/memory';

/**
 * 构造测试节点；缺省标题用 ID。
 * @param id 节点 ID
 * @param parentId 真实父节点
 * @param extra 覆盖字段
 * @returns 已保存形状的节点
 */
function makeNode(
  id: string,
  parentId: string | null,
  extra: Partial<CognitionNode> = {},
): CognitionNode {
  return {
    id,
    parentId,
    body: { title: '节点 ' + id },
    origin: { kind: 'branch' },
    ...extra,
  };
}

/**
 * 构造最小形成记录。
 * @param id 修订 ID
 * @param at 发生时间
 * @param by 执行者种类
 * @param nodeIds 关联节点
 * @param summary 叙述
 * @returns 形成记录
 */
function makeFormation(
  id: string,
  at: string,
  by: 'human' | 'ai',
  nodeIds: string[],
  summary = '形成 ' + id,
): Revision {
  return {
    id,
    kind: 'formation',
    at,
    by,
    nodeIds,
    summary,
    detail: {
      action: 'addBranch',
      effects: nodeIds.map((nodeId) => ({ nodeId, afterState: 'keep' })),
    },
  };
}

/**
 * 构造人确认记录。
 * @param id 修订 ID
 * @param at 发生时间
 * @param target 被确认的形成记录或导入判断
 * @param nodeIds 关联节点
 * @returns 确认记录
 */
function makeConfirmation(
  id: string,
  at: string,
  target: ConfirmTarget,
  nodeIds: string[],
): Revision {
  return {
    id,
    kind: 'confirmation',
    at,
    by: 'human',
    nodeIds,
    summary: '人确认 ' + id,
    detail: { target },
  };
}

/**
 * 从待确认项取定位 ID，供断言顺序。
 * @param item 待确认目标
 * @returns 修订 ID 或导入节点 ID
 */
function idOf(item: PendingTarget): string {
  return item.revisionId ?? item.seedNodeId ?? '';
}

/**
 * 按页读完全部待确认项；每页末项作为下一页游标。
 * @param snapshot 固定版本快照
 * @param by 执行者筛选
 * @param limit 每页条数
 * @returns 全部项，按快照定义的顺序
 */
async function readAllUnconfirmed(
  snapshot: ReadSnapshot,
  by: RevisionActor[],
  limit: number,
): Promise<PendingTarget[]> {
  const result: PendingTarget[] = [];
  let after: ConfirmTarget | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await snapshot.listUnconfirmed(by, after, limit);
    result.push(...page);
    if (page.length < limit) break;
    const last = page[page.length - 1];
    if (last === undefined) break;
    if (last.revisionId !== undefined) {
      after = { revisionId: last.revisionId };
    } else if (last.seedNodeId !== undefined) {
      after = { seedNodeId: last.seedNodeId };
    } else {
      break;
    }
  }
  return result;
}

/**
 * 创建一棵含根与三个孩子的树用于分页测试。
 * @returns 已提交的 store
 */
async function createPagingTree(): Promise<MemoryTreeStore> {
  const store = new MemoryTreeStore();
  await store.transact('T1', 'createNew', (tx) => {
    tx.writeNode(makeNode('T1', null));
    tx.writeNode(makeNode('T1.2', 'T1'));
    tx.writeNode(makeNode('T1.3', 'T1'));
    tx.writeNode(makeNode('T1.10', 'T1'));
  });
  return store;
}

describe('ReadSnapshot · 父子与引用分批', () => {
  it('子节点按稳定 ID 自然序分页，读尽后为空', async () => {
    const snapshot = await (await createPagingTree()).openRead('T1');
    const first = await snapshot.listChildren('T1', null, 2);
    expect(first.map((row) => row.id)).toEqual(['T1.2', 'T1.3']);
    expect(first[0]).not.toHaveProperty('body');
    expect(first[0]?.title).toBe('节点 T1.2');

    const second = await snapshot.listChildren('T1', 'T1.3', 2);
    expect(second.map((row) => row.id)).toEqual(['T1.10']);
    expect(await snapshot.listChildren('T1', 'T1.10', 2)).toEqual([]);
    expect(await snapshot.listChildren('不存在', null, 2)).toEqual([]);
  });

  it('出向按起点、入向按树内目标分页；外部材料不进反向索引', async () => {
    const store = new MemoryTreeStore();
    await store.transact('T1', 'createNew', (tx) => {
      tx.writeNode(makeNode('T1', null));
      tx.writeNode(makeNode('A', 'T1'));
    });
    await store.transact('T1', 'existing', (tx) => {
      tx.writeRef({ id: 'E1', from: 'T1', kind: 'premise', target: { nodeId: 'A' } });
      tx.writeRef({ id: 'E2', from: 'T1', kind: 'example', target: { doc: 'docs/a.md' } });
      tx.writeRef({ id: 'E3', from: 'A', kind: 'conflict', target: { nodeId: 'T1' } });
      tx.writeRef({ id: 'E4', from: 'A', kind: 'premise', target: { nodeId: 'A', part: '理由' } });
    });
    const snapshot = await store.openRead('T1');
    expect((await snapshot.listRefsFrom('T1', null, 1)).map((ref) => ref.id)).toEqual(['E1']);
    expect((await snapshot.listRefsFrom('T1', 'E1', 1)).map((ref) => ref.id)).toEqual(['E2']);
    expect((await snapshot.listRefsFrom('T1', 'E2', 5)).map((ref) => ref.id)).toEqual([]);
    expect((await snapshot.listRefsTo('A', null, 5)).map((ref) => ref.id)).toEqual(['E1', 'E4']);
    expect((await snapshot.listRefsTo('T1', null, 5)).map((ref) => ref.id)).toEqual(['E3']);
    // 外部材料目标是 E2，但 E2 没有树内目标，不能出现在任何入向索引里。
    expect((await snapshot.listRefsTo('docs/a.md', null, 5))).toEqual([]);
  });
});

describe('ReadSnapshot · 时间键', () => {
  it('时区、同日不同偏移、仅日期与同一时刻都能稳定排序', async () => {
    const store = new MemoryTreeStore();
    await store.transact('T1', 'createNew', (tx) => {
      tx.writeNode(makeNode('T1', null));
      tx.writeNode(makeNode('A', 'T1'));
      tx.writeNode(makeNode('B', 'T1'));
    });
    await store.transact('T1', 'existing', (tx) => {
      tx.appendRevision(makeFormation('R1', '2026-11-20T01:00:00Z', 'ai', ['A']));
      tx.appendRevision(makeFormation('R2', '2026-11-20T08:00:00+08:00', 'ai', ['B']));
      tx.appendRevision(makeFormation('R3', '2026-11-19', 'ai', ['T1']));
      tx.appendRevision(makeFormation('R4', '2026-11-20T00:30:00+08:00', 'human', ['A']));
      tx.appendRevision(makeFormation('R5', '2026-11-19T20:00:00-05:00', 'human', ['A', 'B']));
    });
    const snapshot = await store.openRead('T1');

    const timeline = await snapshot.listRevisions(null, null, 10);
    expect(timeline.map((revision) => revision.id)).toEqual(['R5', 'R1', 'R2', 'R4', 'R3']);

    const first = await snapshot.listRevisions(null, null, 2);
    expect(first.map((revision) => revision.id)).toEqual(['R5', 'R1']);
    const second = await snapshot.listRevisions(null, 'R1', 2);
    expect(second.map((revision) => revision.id)).toEqual(['R2', 'R4']);
    const third = await snapshot.listRevisions(null, 'R4', 2);
    expect(third.map((revision) => revision.id)).toEqual(['R3']);
    expect(await snapshot.listRevisions(null, 'R3', 2)).toEqual([]);

    expect((await snapshot.listRevisions('A', null, 10)).map((revision) => revision.id)).toEqual([
      'R5',
      'R1',
      'R4',
    ]);
    expect((await snapshot.listRevisions('B', null, 10)).map((revision) => revision.id)).toEqual([
      'R5',
      'R2',
    ]);
    expect((await snapshot.listRevisions('T1', null, 10)).map((revision) => revision.id)).toEqual([
      'R3',
    ]);

    await expect(snapshot.listRevisions(null, 'NO-SUCH', 2)).rejects.toBeInstanceOf(CognitionError);
  });

  it('大量修订按时间键分页仍然有序、不重不漏', async () => {
    const store = new MemoryTreeStore();
    await store.transact('T1', 'createNew', (tx) => {
      tx.writeNode(makeNode('T1', null));
    });
    await store.transact('T1', 'existing', (tx) => {
      for (let index = 0; index < 200; index += 1) {
        const hour = String(Math.floor(index / 60)).padStart(2, '0');
        const minute = String(index % 60).padStart(2, '0');
        const id = 'R' + String(index).padStart(3, '0');
        tx.appendRevision(
          makeFormation(id, `2026-11-20T${hour}:${minute}:00Z`, 'ai', ['T1']),
        );
      }
    });
    const snapshot = await store.openRead('T1');
    const ids: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await snapshot.listRevisions(null, after, 37);
      ids.push(...page.map((revision) => revision.id));
      if (page.length < 37) break;
      after = page[page.length - 1]?.id ?? null;
    }
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect(ids[0]).toBe('R199');
    expect(ids[199]).toBe('R000');
  });
});

describe('ReadSnapshot · 未确认索引', () => {
  /**
   * 建一棵含导入判断和两类执行者形成记录的树。
   * @returns 已提交的 store
   */
  async function createUnconfirmedTree(): Promise<MemoryTreeStore> {
    const store = new MemoryTreeStore();
    await store.transact('T1', 'createNew', (tx) => {
      tx.writeNode(makeNode('T1', null));
      tx.writeNode(makeNode('I1', 'T1', { confirmation: 'unconfirmed' }));
      tx.writeNode(makeNode('I2', 'T1', { confirmation: 'humanConfirmed' }));
      tx.writeNode(makeNode('I3', 'T1'));
      tx.writeNode(makeNode('I4', 'T1', { confirmation: 'unconfirmed' }));
      tx.writeNode(makeNode('I5', 'T1', { confirmation: 'unconfirmed' }));
      tx.writeNode(makeNode('N1', 'T1'));
      tx.writeNode(makeNode('N2', 'T1'));
      tx.writeNode(makeNode('N3', 'T1'));
    });
    await store.transact('T1', 'existing', (tx) => {
      tx.appendRevision(makeFormation('F1', '2026-11-20T09:00:00+08:00', 'ai', ['N1', 'N2']));
      tx.appendRevision(makeFormation('F2', '2026-11-20T10:00:00+08:00', 'human', ['N3']));
      tx.writeNode(
        makeNode('N1', 'T1', {
          confirmation: 'unconfirmed',
          currentChange: { revisionId: 'F1', by: 'ai' },
        }),
      );
      tx.writeNode(
        makeNode('N2', 'T1', {
          confirmation: 'unconfirmed',
          currentChange: { revisionId: 'F1', by: 'ai' },
        }),
      );
      tx.writeNode(
        makeNode('N3', 'T1', {
          confirmation: 'unconfirmed',
          currentChange: { revisionId: 'F2', by: 'human' },
        }),
      );
    });
    return store;
  }

  it('纯 import 分页能从第二页继续，且只列 unconfirmed 的导入判断', async () => {
    const snapshot = await (await createUnconfirmedTree()).openRead('T1');
    const all = await snapshot.listUnconfirmed(['import'], null, 10);
    expect(all.map(idOf)).toEqual(['I1', 'I4', 'I5']);
    expect(all[0]).toMatchObject({ seedNodeId: 'I1', title: '节点 I1' });

    const page1 = await snapshot.listUnconfirmed(['import'], null, 1);
    expect(page1.map(idOf)).toEqual(['I1']);
    const page2 = await snapshot.listUnconfirmed(['import'], { seedNodeId: 'I1' }, 1);
    expect(page2.map(idOf)).toEqual(['I4']);
    const page3 = await snapshot.listUnconfirmed(['import'], { seedNodeId: 'I4' }, 1);
    expect(page3.map(idOf)).toEqual(['I5']);
    expect(await snapshot.listUnconfirmed(['import'], { seedNodeId: 'I5' }, 1)).toEqual([]);

    expect((await readAllUnconfirmed(snapshot, ['import'], 1)).map(idOf)).toEqual([
      'I1',
      'I4',
      'I5',
    ]);
  });

  it('形成记录按时间与修订 ID 排，导入判断排后；混合分页跨段不重不漏', async () => {
    const snapshot = await (await createUnconfirmedTree()).openRead('T1');
    expect((await snapshot.listUnconfirmed(['ai'], null, 10)).map(idOf)).toEqual(['F1']);
    expect((await snapshot.listUnconfirmed(['human'], null, 10)).map(idOf)).toEqual(['F2']);
    const all = await snapshot.listUnconfirmed(['human', 'ai', 'import'], null, 10);
    expect(all.map(idOf)).toEqual(['F2', 'F1', 'I1', 'I4', 'I5']);
    expect(all[0]).toMatchObject({ revisionId: 'F2', nodeIds: ['N3'] });
    expect(all[1]).toMatchObject({ revisionId: 'F1', nodeIds: ['N1', 'N2'] });

    const pages = await readAllUnconfirmed(snapshot, ['human', 'ai', 'import'], 2);
    expect(pages.map(idOf)).toEqual(['F2', 'F1', 'I1', 'I4', 'I5']);

    // 只筛形成记录时，不能因为游标跨到导入段而重复或漏项。
    const formationOnly = await readAllUnconfirmed(snapshot, ['human', 'ai'], 1);
    expect(formationOnly.map(idOf)).toEqual(['F2', 'F1']);
  });

  it('确认同一记录的部分节点后仍列出剩余节点；全部确认后才消失', async () => {
    const store = await createUnconfirmedTree();
    const before = await store.openRead('T1');
    expect((await before.listUnconfirmed(['ai'], null, 10))[0]).toMatchObject({
      revisionId: 'F1',
      nodeIds: ['N1', 'N2'],
    });

    await store.transact('T1', 'existing', async (tx) => {
      const node = await tx.readNode('N1');
      expect(node).not.toBeNull();
      if (node === null) return;
      const already = await tx.hasConfirmation({ revisionId: 'F1' });
      expect(already).toBe(false);
      tx.appendRevision(
        makeConfirmation('C1', '2026-11-20T11:00:00+08:00', { revisionId: 'F1' }, ['N1']),
      );
      expect(await tx.hasConfirmation({ revisionId: 'F1' })).toBe(true);
      tx.writeNode({ ...node, confirmation: 'humanConfirmed' });
    });

    const half = await store.openRead('T1');
    expect((await half.listUnconfirmed(['ai'], null, 10))[0]).toMatchObject({
      revisionId: 'F1',
      nodeIds: ['N2'],
    });
    // 旧快照仍看到确认前的两个节点。
    expect((await before.listUnconfirmed(['ai'], null, 10))[0]).toMatchObject({
      nodeIds: ['N1', 'N2'],
    });

    await store.transact('T1', 'existing', async (tx) => {
      const node = await tx.readNode('N2');
      expect(await tx.hasConfirmation({ revisionId: 'F1' })).toBe(true);
      if (node === null) return;
      tx.writeNode({ ...node, confirmation: 'humanConfirmed' });
    });
    expect(await (await store.openRead('T1')).listUnconfirmed(['ai'], null, 10)).toEqual([]);
  });

  it('节点被后续变更改指针后，旧形成记录消失并出现新记录', async () => {
    const store = await createUnconfirmedTree();
    await store.transact('T1', 'existing', async (tx) => {
      const node = await tx.readNode('N1');
      if (node === null) return;
      tx.appendRevision(makeFormation('F3', '2026-11-20T12:00:00+08:00', 'ai', ['N1']));
      tx.writeNode({
        ...node,
        currentChange: { revisionId: 'F3', by: 'ai' },
        confirmation: 'unconfirmed',
      });
      // N1 不再指向 F1；F1 仍由 N2 指向。
    });
    const snapshot = await store.openRead('T1');
    const pending = await snapshot.listUnconfirmed(['ai'], null, 10);
    expect(pending.map(idOf)).toEqual(['F3', 'F1']);
    expect(pending[1]).toMatchObject({ revisionId: 'F1', nodeIds: ['N2'] });
  });

  it('确认导入判断后从 import 索引消失，重复确认目标可查重', async () => {
    const store = await createUnconfirmedTree();
    await store.transact('T1', 'existing', async (tx) => {
      const node = await tx.readNode('I1');
      if (node === null) return;
      expect(await tx.hasConfirmation({ seedNodeId: 'I1' })).toBe(false);
      tx.appendRevision(
        makeConfirmation('C2', '2026-11-20T12:30:00+08:00', { seedNodeId: 'I1' }, ['I1']),
      );
      expect(await tx.hasConfirmation({ seedNodeId: 'I1' })).toBe(true);
      tx.writeNode({ ...node, confirmation: 'humanConfirmed' });
    });
    const snapshot = await store.openRead('T1');
    expect((await snapshot.listUnconfirmed(['import'], null, 10)).map(idOf)).toEqual(['I4', 'I5']);
    await expect(
      store.transact('T1', 'existing', (tx) => tx.hasConfirmation({ seedNodeId: 'I1' })),
    ).resolves.toBe(true);
  });
});
