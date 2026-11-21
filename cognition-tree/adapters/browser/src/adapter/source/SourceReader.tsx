/**
 * 出处阅读器：在页内显示研究材料原文，高亮引用指出的局部。浏览器宿主专有，不属于 UI 内核。
 * 浮层只用页面底色 + 一条强细线分开；Esc 关闭（只关阅读器，不影响页面上的选中）。
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { SourceReaderStore } from './source-reader';
import './source.css';

/**
 * 把一行里出现的 part 包成高亮。
 * @param line 一行文字
 * @param part 要高亮的局部；没有时原样返回
 */
function highlight(line: string, part: string | undefined): ReactNode {
  if (!part) return line;
  const pieces = line.split(part);
  if (pieces.length === 1) return line;
  const out: ReactNode[] = [];
  pieces.forEach((p, i) => {
    if (i > 0) out.push(<mark key={'m' + i}>{part}</mark>);
    if (p) out.push(p);
  });
  return out;
}

/**
 * 阅读器。
 * @param props.reader 阅读器状态（由 HostBridge.openSource 驱动）
 */
export function SourceReader(props: { reader: SourceReaderStore }) {
  const { reader } = props;
  const s = useSyncExternalStore(reader.subscribe, reader.get);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!s.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      reader.close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [s.open, reader]);

  useEffect(() => {
    if (s.status === 'ready' && s.part) bodyRef.current?.querySelector('mark')?.scrollIntoView({ block: 'center' });
  }, [s.status, s.part, s.text]);

  if (!s.open) return null;
  const href = reader.url(s.doc);
  const lines = (s.text ?? '').split(/\r?\n/);
  return (
    <div className="ct-src-veil" onMouseDown={() => reader.close()}>
      <article className="ct-src" role="dialog" aria-label={'出处：' + s.doc} onMouseDown={(e) => e.stopPropagation()}>
        <header className="ct-src__head">
          <div className="ct-src__names">
            <span className="ct-src__label">出处 · 研究材料原文</span>
            <span className="ct-src__path ct-mono">{s.doc}</span>
          </div>
          {s.part && <span className="ct-src__part">定位：{s.part}</span>}
          <span className="ct-src__spacer" />
          {href && (
            <a className="ct-src__action" href={href} target="_blank" rel="noreferrer">
              新标签打开
            </a>
          )}
          <button type="button" className="ct-src__action" onClick={() => reader.close()}>
            关闭 ×
          </button>
        </header>
        <div ref={bodyRef} className="ct-src__body ct-scroll">
          {s.status === 'loading' && <div className="ct-src__state">正在读取…</div>}
          {s.status === 'error' && <div className="ct-src__state is-error">{s.error}</div>}
          {s.status === 'ready' &&
            lines.map((line, i) => {
              const h = /^(#{1,6})\s+(.*)$/.exec(line);
              if (h) {
                return (
                  <div key={i} className={'ct-src__h ct-src__h' + h[1].length}>
                    {highlight(h[2], s.part)}
                  </div>
                );
              }
              if (line.trim() === '') return <div key={i} className="ct-src__gap" />;
              return (
                <div key={i} className="ct-src__line">
                  {highlight(line, s.part)}
                </div>
              );
            })}
        </div>
      </article>
    </div>
  );
}
