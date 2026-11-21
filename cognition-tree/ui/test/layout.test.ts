/**
 * 分层布局：根在原点、层沿一个轴推进、兄弟次序稳定、重复计算一致。
 */
import { describe, expect, it } from 'vitest';
import { layeredLayout, layoutTree } from '../src/utils/layout';

/** 一棵三层的样例树：root → a、b；a → a1、a2。 */
const NODES = [
  { id: 'root', parentId: null },
  { id: 'a', parentId: 'root' },
  { id: 'b', parentId: 'root' },
  { id: 'a1', parentId: 'a' },
  { id: 'a2', parentId: 'a' },
];

describe('分层布局', () => {
  it('根在原点，横向树的层沿 x 推进、纵向树沿 y 推进', () => {
    const h = layeredLayout(NODES, 'root', 'horizontal');
    expect(h.pos.get('root')).toMatchObject({ x: 0, y: 0 });
    expect(h.pos.get('a')!.x).toBeGreaterThan(h.pos.get('root')!.x);
    expect(h.pos.get('a1')!.x).toBeGreaterThan(h.pos.get('a')!.x);

    const v = layeredLayout(NODES, 'root', 'vertical');
    expect(v.pos.get('root')).toMatchObject({ x: 0, y: 0 });
    expect(v.pos.get('a')!.y).toBeGreaterThan(v.pos.get('root')!.y);
    expect(v.pos.get('a1')!.y).toBeGreaterThan(v.pos.get('a')!.y);
  });

  it('兄弟按稳定 ID 次序占槽，子树不重叠', () => {
    const h = layeredLayout(NODES, 'root', 'horizontal');
    expect(h.pos.get('a')!.y).toBeLessThan(h.pos.get('b')!.y);
    expect(h.pos.get('a1')!.y).toBeLessThan(h.pos.get('a2')!.y);
    expect(Math.abs(h.pos.get('a1')!.y - h.pos.get('a2')!.y)).toBeGreaterThan(40);
  });

  it('重复计算得到同一套坐标（位置记忆不抖）', () => {
    const first = layeredLayout(NODES, 'root', 'horizontal');
    const second = layeredLayout(NODES, 'root', 'horizontal');
    for (const [id, p] of first.pos) expect(second.pos.get(id)).toEqual(p);
  });

  it('根不在已读节点里时返回空布局', () => {
    expect(layeredLayout(NODES.filter((n) => n.id !== 'root'), 'root', 'horizontal').pos.size).toBe(0);
  });

  it('layoutTree 按模式分派，径向仍以根为原点', () => {
    expect(layoutTree('radial', NODES, 'root').pos.get('root')).toMatchObject({ x: 0, y: 0 });
    expect(layoutTree('vertical', NODES, 'root').pos.size).toBe(NODES.length);
  });
});
