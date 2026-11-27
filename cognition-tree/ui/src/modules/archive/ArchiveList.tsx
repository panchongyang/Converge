/**
 * 归档列表：整树（目录页）与显式分支（树视图）共用的一张简单管理表。
 *
 * 职责：挂载或收到刷新信号时读一次归档；每行一个「恢复」；恢复成功后重新读列表并通知
 * 调用方刷新目录或树。失败保留列表与 code/message，不把半份结果当完整归档。
 * 状态归属：列表、读取失败与每行恢复进度都在本组件；归档事实只经 ArchiveAccess 端口交换。
 * 边界：不提供归档动作（由目录行与阅读栏发起）、不搜索、不批量、不写 localStorage；
 * 不在提交前把行移除——恢复后的可见性以重新读取为准。独立浏览器不挂本组件。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TreeId } from '../../types/kernel';
import type { ArchiveAccess, ArchiveItem } from '../../types/ports';
import { Button } from '../../components';
import { toUiError, type UiError } from '../../utils/errors';
import { ARCHIVE_COPY, archiveItemKey, archiveItemTitle, archiveTarget } from './model';
import './archive.css';

/** 归档列表的读取状态；刷新时保留已有行。 */
type ListStatus = 'loading' | 'ready' | 'error';

export interface ArchiveListProps {
  /** 环境提供的归档端口；没有它就不应挂载本组件。 */
  archive: ArchiveAccess;
  /** 省略只列整棵已归档的树；给定时列该活动树里显式归档的分支。 */
  treeId?: TreeId;
  /** 每次成功恢复后调用，让目录重读或树按新版本重读。 */
  onRestored: (item: ArchiveItem) => void;
  /** 刷新信号；归档或恢复后由调用方递增，列表据此重新读取。 */
  refreshKey?: number;
  /** 是否显示列表标题与说明；嵌在目录里时用 true，只有一个列表时也够用。 */
  heading?: boolean;
  /** 额外类名，便于放进不同栏位。 */
  className?: string;
}

/**
 * 归档列表。
 * @param props 见 ArchiveListProps
 */
export function ArchiveList(props: ArchiveListProps) {
  const { archive, treeId, onRestored, refreshKey = 0, heading = true } = props;
  const [status, setStatus] = useState<ListStatus>('loading');
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [error, setError] = useState<UiError | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<UiError | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * 读一次归档。
   * @param keep 已有列表时保留它并只在失败处显示原因；首次读取显示加载态
   */
  const load = useCallback(
    async (keep: boolean) => {
      const token = ++seq.current;
      setStatus((prev) => (keep && prev === 'ready' ? prev : 'loading'));
      setError(null);
      try {
        const list = await archive.list(treeId);
        if (!mounted.current || token !== seq.current) return;
        setItems(list);
        setStatus('ready');
      } catch (e) {
        if (!mounted.current || token !== seq.current) return;
        setError(toUiError(e));
        setStatus((prev) => (keep && prev === 'ready' ? prev : 'error'));
      }
    },
    [archive, treeId],
  );

  // 首次挂载与外部刷新信号：归档列表是服务端事实，不在客户端缓存或轮询。
  useEffect(() => {
    void load(false);
  }, [load, refreshKey]);

  /**
   * 恢复一项：先等服务端确认，再重读列表；成功后通知调用方重读目录/树。
   * @param item 要恢复的归档项
   */
  const restore = async (item: ArchiveItem) => {
    if (busyKey) return;
    const key = archiveItemKey(item);
    setBusyKey(key);
    setRestoreError(null);
    try {
      await archive.restore(archiveTarget(item.treeId, item.nodeId));
      await load(true);
      if (mounted.current) onRestored(item);
    } catch (e) {
      if (mounted.current) setRestoreError(toUiError(e));
    } finally {
      if (mounted.current) setBusyKey(null);
    }
  };

  const archiving = treeId !== undefined;
  const title = archiving ? ARCHIVE_COPY.archivedBranchesTitle : ARCHIVE_COPY.archivedTrees;
  const emptyText = archiving ? ARCHIVE_COPY.archivedBranchesEmpty : ARCHIVE_COPY.archivedTreesEmpty;
  const desc = archiving ? ARCHIVE_COPY.archivedBranchesDesc : ARCHIVE_COPY.archivedTreesDesc;

  return (
    <section className={'ct-arc' + (props.className ? ' ' + props.className : '')} aria-label={title}>
      {heading && (
        <div className="ct-arc__head">
          <h2 className="ct-arc__title">{title}</h2>
          {status === 'ready' && <span className="ct-arc__count">{items.length} 项</span>}
        </div>
      )}
      {heading && <p className="ct-arc__desc">{desc}</p>}

      {status === 'loading' && (
        <div className="ct-arc__state" role="status">
          {ARCHIVE_COPY.loading}
        </div>
      )}

      {status === 'error' && (
        <div className="ct-arc__state ct-arc__state--error">
          <div className="ct-arc__errortitle">{ARCHIVE_COPY.errorTitle}</div>
          {error && <p className="ct-arc__errordesc">{error.message}</p>}
          <Button size="sm" onClick={() => void load(false)}>
            {ARCHIVE_COPY.retry}
          </Button>
        </div>
      )}

      {status === 'ready' && (
        <>
          {error && (
            <div className="ct-arc__banner" role="status">
              <span>{error.message}</span>
              <button type="button" className="ct-textbtn" disabled={busyKey !== null} onClick={() => void load(true)}>
                {ARCHIVE_COPY.retry}
              </button>
            </div>
          )}
          {items.length === 0 ? (
            <p className="ct-arc__empty">{emptyText}</p>
          ) : (
            <ul className="ct-arc__list">
              {items.map((item) => {
                const key = archiveItemKey(item);
                return (
                  <li key={key} className="ct-arc__row">
                    <span className="ct-arc__name">{archiveItemTitle(item)}</span>
                    <span className="ct-arc__meta">
                      <span className="ct-mono ct-arc__id" title={item.nodeId ? '分支 ' + item.nodeId : '树 ' + item.treeId}>
                        {item.nodeId ?? item.treeId}
                      </span>
                      {item.nodeId && (
                        <span className="ct-mono ct-arc__tree" title={'所属树 ' + item.treeId}>
                          {item.treeId}
                        </span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busyKey === key}
                      disabled={busyKey !== null && busyKey !== key}
                      onClick={() => void restore(item)}
                    >
                      {busyKey === key ? ARCHIVE_COPY.restoring : ARCHIVE_COPY.restore}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {restoreError && (
            <p className="ct-arc__error" role="alert">
              {ARCHIVE_COPY.restoreFailed}
              {restoreError.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
