/**
 * 大纲：同一视野的缩进树阅读方式，与空间共用选中、悬停与续读。
 *
 * 只列当前视野里的节点，按真实父子关系缩进；引用不当第二个父节点，只在悬停或选中时计数。
 * 收起 / 展开是阅读状态，不写树。边界行与空间里的芽同义：参数范围到此可展开一层，预算先到可续读。
 * 键盘（焦点在列表上）：↑↓ 移动选中；← 收起或回到父判断；→ 展开或进入第一个子判断。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Boundary, NodeId, Ref, RefId, ViewNode } from '../../types/kernel';
import { compareIds } from '../../utils/ids';
import { confirmationLabel, confirmationView, isAiProposed, originMark, stateLabel } from '../../utils/labels';
import { NodeGlyph } from '../../components';
import './outline.css';

export interface OutlineProps {
  rootId: NodeId;
  known: Map<NodeId, ViewNode>;
  visible: Set<NodeId>;
  roles: Map<NodeId, 'hit' | 'link'>;
  refs: Map<RefId, Ref>;
  boundaries: Boundary[];
  selectedId: NodeId | null;
  hoveredId: NodeId | null;
  highlightIds: NodeId[];
  /** 大纲模式下占满宽度。 */
  wide: boolean;
  onSelect: (id: NodeId) => void;
  onHover: (id: NodeId | null) => void;
  onExpand: (id: NodeId, axis: 'children' | 'refs', kind: Boundary['kind']) => void;
}

interface Row {
  id: NodeId;
  depth: number;
  node: ViewNode;
  hasKids: boolean;
  collapsed: boolean;
}

type Line = { type: 'node'; row: Row } | { type: 'bound'; key: string; nodeId: NodeId; depth: number; b: Boundary };

const BOUND_TEXT: Record<string, string> = {
  'scope:children': '参数范围到此，还有子判断 · 展开一层',
  'scope:refs': '参数范围到此，还有引用 · 跳一跳',
  'budget:children': '预算先到，子判断没读完 · 续读',
  'budget:refs': '预算先到，引用没读完 · 续读',
};

/**
 * 大纲视图。
 * @param p 见 OutlineProps
 */
export function Outline(p: OutlineProps) {
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<NodeId | null>(null);

  const children = useMemo(() => {
    const m = new Map<NodeId, NodeId[]>();
    for (const id of p.visible) {
      const parentId = p.known.get(id)?.parentId;
      if (!parentId || !p.visible.has(parentId)) continue;
      const list = m.get(parentId) ?? [];
      list.push(id);
      m.set(parentId, list);
    }
    for (const list of m.values()) list.sort(compareIds);
    return m;
  }, [p.visible, p.known]);

  const refCount = useMemo(() => {
    const m = new Map<NodeId, number>();
    const bump = (id: NodeId) => m.set(id, (m.get(id) ?? 0) + 1);
    for (const r of p.refs.values()) {
      bump(r.from);
      if (r.target.nodeId !== undefined) bump(r.target.nodeId);
    }
    return m;
  }, [p.refs]);

  const lines = useMemo(() => {
    const out: Line[] = [];
    const walk = (id: NodeId, depth: number) => {
      const node = p.known.get(id);
      if (!node) return;
      const kids = children.get(id) ?? [];
      const isCollapsed = kids.length > 0 && collapsed.has(id);
      out.push({ type: 'node', row: { id, depth, node, hasKids: kids.length > 0, collapsed: isCollapsed } });
      if (isCollapsed) return;
      for (const k of kids) walk(k, depth + 1);
      for (const b of p.boundaries) {
        if (b.nodeId === id) out.push({ type: 'bound', key: id + ':' + b.axis, nodeId: id, depth: depth + 1, b });
      }
    };
    if (p.visible.has(p.rootId)) walk(p.rootId, 0);
    return out;
  }, [p.rootId, p.visible, p.known, p.boundaries, children, collapsed]);

  const rows = useMemo(() => lines.flatMap((l) => (l.type === 'node' ? [l.row] : [])), [lines]);

  /** 收起或展开一个节点（只改阅读状态）。 */
  const toggle = (id: NodeId) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 从别处选中被收起的深处节点时，先展开它的祖先。
  useEffect(() => {
    if (!p.selectedId) return;
    const ancestors: NodeId[] = [];
    for (let id = p.known.get(p.selectedId)?.parentId ?? null; id; id = p.known.get(id)?.parentId ?? null) ancestors.push(id);
    setCollapsed((s) => (ancestors.some((a) => s.has(a)) ? new Set([...s].filter((x) => !ancestors.includes(x))) : s));
  }, [p.selectedId, p.known]);

  // 选中变化后把对应行滚进可视区。
  useEffect(() => {
    const id = p.selectedId;
    if (!id || scrolledFor.current === id) return;
    const el = listRef.current?.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      scrolledFor.current = id;
    }
  }, [p.selectedId, lines]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.id === p.selectedId);
    const cur = rows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)];
      if (next) p.onSelect(next.id);
    } else if (e.key === 'ArrowLeft' && cur) {
      e.preventDefault();
      if (cur.hasKids && !cur.collapsed) toggle(cur.id);
      else if (cur.node.parentId) p.onSelect(cur.node.parentId);
    } else if (e.key === 'ArrowRight' && cur) {
      e.preventDefault();
      if (cur.collapsed) toggle(cur.id);
      else {
        const first = children.get(cur.id)?.[0];
        if (first) p.onSelect(first);
      }
    }
  };

  const highlight = new Set(p.highlightIds);
  return (
    <div className={'ct-ol' + (p.wide ? ' is-wide' : '')}>
      <div className="ct-ol__head">
        <span className="ct-ol__count">
          大纲 · {rows.length} 个判断
        </span>
        <span className="ct-ol__acts">
          <button type="button" className="ct-textbtn" onClick={() => setCollapsed(new Set())}>
            全部展开
          </button>
          <span className="ct-ol__sep" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            className="ct-textbtn"
            onClick={() => setCollapsed(new Set([...children.keys()].filter((id) => id !== p.rootId)))}
          >
            收起
          </button>
        </span>
      </div>
      <div ref={listRef} className="ct-ol__list ct-scroll" role="tree" aria-label="大纲" tabIndex={0} onKeyDown={onKeyDown}>
        {lines.map((l) => {
          if (l.type === 'bound') {
            return (
              <button
                key={l.key}
                type="button"
                className={'ct-ol__bound is-' + l.b.kind}
                style={{ '--depth': l.depth } as CSSProperties}
                onClick={() => p.onExpand(l.nodeId, l.b.axis, l.b.kind)}
              >
                <span className="ct-ol__bound-mark">{l.b.axis === 'children' ? '+' : '⋯'}</span>
                {BOUND_TEXT[l.b.kind + ':' + l.b.axis]}
              </button>
            );
          }
          const { row } = l;
          const n = row.node;
          const mark = originMark(n.origin);
          const refs = refCount.get(row.id) ?? 0;
          const link = p.roles.get(row.id) === 'link';
          // 状态词与引用数不上屏，但读屏仍拿到同一组状态与例外标记。
          const aria =
            row.id +
            ' ' +
            n.title +
            '，' +
            stateLabel(n.state) +
            '，' +
            confirmationLabel(confirmationView(n)) +
            (link ? '，连接' : '') +
            (refs > 0 ? '，' + refs + ' 条引用' : '');
          const cls =
            'ct-ol__row' +
            (row.id === p.selectedId ? ' is-selected' : '') +
            (row.id === p.hoveredId ? ' is-hovered' : '') +
            (highlight.has(row.id) ? ' is-highlight' : '') +
            (n.state === 'prune' ? ' is-pruned' : '') +
            (isAiProposed(n) ? ' is-proposed' : '') +
            (link ? ' is-link' : '') +
            (row.id === p.rootId ? ' is-root' : '');
          return (
            <div
              key={row.id}
              data-id={row.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-label={aria}
              aria-selected={row.id === p.selectedId}
              aria-expanded={row.hasKids ? !row.collapsed : undefined}
              className={cls}
              style={{ '--depth': row.depth } as CSSProperties}
              onClick={() => {
                p.onSelect(row.id);
                listRef.current?.focus();
              }}
              onMouseEnter={() => p.onHover(row.id)}
              onMouseLeave={() => p.onHover(null)}
            >
              <span className="ct-ol__twist" aria-hidden="true">
                {row.hasKids ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className="ct-ol__twistbtn"
                    aria-label={row.collapsed ? '展开' : '收起'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(row.id);
                    }}
                  >
                    {row.collapsed ? '›' : '⌄'}
                  </button>
                ) : (
                  <span className="ct-ol__leaf" />
                )}
              </span>
              <NodeGlyph state={n.state} confirmation={confirmationView(n)} size={12} title={stateLabel(n.state)} />
              <span className="ct-ol__title">{n.title}</span>
              {mark && <span className="ct-ol__mark">{mark}</span>}
              {isAiProposed(n) && <span className="ct-ol__ai">AI 提出</span>}
              {link && <span className="ct-ol__link" title="仅为连回根而补入，其余孩子没有读入视野">连接</span>}
              {refs > 0 && <span className="ct-ol__refs" title={'涉及 ' + refs + ' 条引用'}>· {refs}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
