/**
 * 查找判断（Ctrl / ⌘ K）：在已读入的节点里按 ID 或标题查找，回车选中并平移过去。
 * 只查 UI 已读到的范围；查不到不等于树里没有（全景下即整棵树）。
 * 浮层只用页面底色与一条强细线分开，不用投影与模糊。
 */
import { useEffect, useMemo, useState } from 'react';
import type { NodeId, ViewNode } from '../../types/kernel';
import { compareIds } from '../../utils/ids';
import { confirmationView } from '../../utils/labels';
import { ConfirmText, NodeGlyph, StateText } from '../../components';
import './search.css';

/**
 * 查找面板。
 * @param props.known 已读节点
 * @param props.onPick 选中一个结果
 * @param props.onClose 关闭面板
 */
export function SearchPalette(props: { known: Map<NodeId, ViewNode>; onPick: (id: NodeId) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const scored = [...props.known.values()]
      .map((n) => {
        const id = n.id.toLowerCase();
        const t = n.title.toLowerCase();
        const score = !s ? 1 : id === s ? 100 : id.startsWith(s) ? 60 : t.includes(s) ? 40 : id.includes(s) ? 20 : 0;
        return { n, score };
      })
      .filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score || compareIds(a.n.id, b.n.id));
    return scored.slice(0, 40).map((x) => x.n);
  }, [q, props.known]);
  useEffect(() => setActive(0), [q]);

  const pick = (id: NodeId) => {
    props.onPick(id);
    props.onClose();
  };
  return (
    <div className="ct-palette-veil" onMouseDown={props.onClose}>
      <div className="ct-palette" role="dialog" aria-label="查找判断" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ct-palette__input">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="按标题查找判断，例如“纯树”"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((x) => Math.min(results.length - 1, x + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((x) => Math.max(0, x - 1));
              } else if (e.key === 'Enter' && results[active]) {
                pick(results[active].id);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                props.onClose();
              }
            }}
          />
          <span className="ct-kbd">Esc</span>
        </div>
        <ul className="ct-palette__list ct-scroll" role="listbox">
          {results.map((n, i) => (
            <li
              key={n.id}
              role="option"
              aria-selected={i === active}
              className={'ct-palette__item' + (i === active ? ' is-active' : '')}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(n.id)}
            >
              <NodeGlyph state={n.state} confirmation={confirmationView(n)} size={13} />
              <span className="ct-palette__title">{n.title}</span>
              <StateText state={n.state} showGlyph={false} />
              <span className="ct-palette__conf">
                <ConfirmText confirmation={confirmationView(n)} />
              </span>
            </li>
          ))}
          {results.length === 0 && <li className="ct-palette__empty">已读入的范围里没有匹配的判断</li>}
        </ul>
        <div className="ct-palette__foot">
          查找只覆盖已读入的节点 · ↑↓ 选择 · ↵ 打开 ·{' '}
          <button type="button" className="ct-textbtn" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
