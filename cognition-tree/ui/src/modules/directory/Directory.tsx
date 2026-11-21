/**
 * 当前工作区的“全部树”列表：默认入口，也是唯一的建树入口。
 *
 * 职责：显示目录、空/失败/部分不可用状态、手动刷新与内联新建树表单；点一行交给宿主进入。
 * 状态归属：目录数据、进入树的绑定由宿主（DSH 面板）持有；本组件只持有表单草稿、
 * 表单开关与本次创建请求的忙碌/失败，成功或换会话后随宿主卸载。
 * 失败：读目录失败可重试且不丢已有列表；创建失败保留草稿，下次提交仍可重试。
 * 边界：不做删除、改名、搜索或 AI 入口；不显示宿主会话 UUID；不在后台轮询，
 * 刷新只由挂载、返回、手动点击触发。
 * 依据：人的决定——侧栏打开默认列表，一行根问题主标题 + 树 ID，选中才进原三栏。
 */
import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button, TextField } from '../../components';
import { toUiError, type UiError } from '../../utils/errors';
import { TREE_ENTRY_COPY, treeDraftIssue, treeErrorText } from '../tree/model';
import {
  DIRECTORY_COPY,
  directoryEmptyCopy,
  directoryItemTitle,
  directorySummary,
  unavailableOnly,
  type DirectoryItem,
} from './model';
import './directory.css';

/** 目录读取状态；refreshing 与 status 分开，刷新时保留已有列表。 */
export type DirectoryStatus = 'loading' | 'ready' | 'error';

/** “全部树”列表的装配参数。 */
export interface TreeDirectoryProps {
  /** 目录读取状态。 */
  status: DirectoryStatus;
  /** 已读到的树；每项都带实际根与根问题，点击后直接进入。 */
  items: readonly DirectoryItem[];
  /** 根问题暂时读不到的树 ID；与 items 互斥，只作为不可点击的占位行。 */
  unavailable: readonly string[];
  /** 目录读取失败；ready 时也会传入（刷新失败），此时列表保留。 */
  error: UiError | null;
  /** 是否正在刷新；刷新中保留列表并禁用重复刷新。 */
  refreshing: boolean;
  /** 重读目录；挂载、返回与手动刷新都走这里。 */
  onRefresh: () => void;
  /** 进入一整行；实际根已经由服务端目录给出，不再二次读取。 */
  onOpen: (item: DirectoryItem) => void;
  /** 新建树；失败时抛出带 code 的业务错误，由本组件就地显示。 */
  onCreate: (treeId: string, rootQuestion: string) => Promise<void>;
}

/**
 * “全部树”目录。
 * @param props 见 TreeDirectoryProps；目录数据由宿主读取，本组件不直接 fetch
 */
export function TreeDirectory(props: TreeDirectoryProps) {
  const { status, items, unavailable, error, refreshing, onRefresh, onOpen, onCreate } = props;
  const [formOpen, setFormOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const [rootQuestion, setRootQuestion] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<UiError | null>(null);
  const [issue, setIssue] = useState<string | null>(null);

  const partial = unavailableOnly(items, unavailable);
  const empty = status === 'ready' ? directoryEmptyCopy(items.length, partial.length) : null;
  const canCreate = !creating && !refreshing && status !== 'loading';
  const summary =
    status === 'ready'
      ? directorySummary(items.length, partial.length)
      : status === 'loading'
        ? DIRECTORY_COPY.loadingShort
        : DIRECTORY_COPY.errorShort;

  /** 打开或收起表单；收起时保留草稿，方便再次展开继续填。 */
  const toggleForm = () => {
    if (creating) return;
    setFormOpen((open) => !open);
    setIssue(null);
    setCreateError(null);
  };

  /** 校验并提交创建；成功后宿主切换到新树，本组件随之卸载。 */
  const submitCreate = async () => {
    if (creating) return;
    const draftIssue = treeDraftIssue({ treeId: newId, rootQuestion });
    if (draftIssue) {
      setIssue(draftIssue);
      setCreateError(null);
      return;
    }
    setIssue(null);
    setCreateError(null);
    setCreating(true);
    try {
      await onCreate(newId, rootQuestion);
    } catch (e) {
      setCreateError(toUiError(e));
    } finally {
      // 成功时宿主会卸载本组件；若宿主因视图已变而没有进入，也要放开下次提交。
      setCreating(false);
    }
  };

  /** Esc 只收起未提交的表单，不把按键交给宿主快捷键；请求在路上时不打断。 */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    if (!formOpen || creating) return;
    e.preventDefault();
    e.stopPropagation();
    setFormOpen(false);
    setIssue(null);
    setCreateError(null);
  };

  return (
    <div className="ct-dir" onKeyDown={onKeyDown}>
      <header className="ct-dir__head">
        <div className="ct-dir__heading">
          <h1 className="ct-dir__title">{DIRECTORY_COPY.title}</h1>
          <p className="ct-dir__sub">
            <span>{DIRECTORY_COPY.workspace}</span>
            <span className="ct-dir__dot" aria-hidden="true">
              ·
            </span>
            <span>{summary}</span>
          </p>
        </div>
        <div className="ct-dir__actions">
          <button
            type="button"
            className="ct-textbtn ct-dir__refresh"
            disabled={refreshing || creating || status === 'loading'}
            onClick={onRefresh}
            title="重新读取当前工作区的树列表"
          >
            {refreshing ? DIRECTORY_COPY.refreshing : DIRECTORY_COPY.refresh}
          </button>
          {status !== 'loading' && !empty && (
            <Button size="sm" variant="primary" disabled={!canCreate} onClick={toggleForm} aria-expanded={formOpen}>
              {formOpen ? DIRECTORY_COPY.cancel : DIRECTORY_COPY.newTree}
            </Button>
          )}
        </div>
      </header>

      <div className="ct-dir__scroll ct-scroll">
        <div className="ct-dir__body">
          {formOpen && (
            <form
              className="ct-dir__form"
              aria-label={DIRECTORY_COPY.createTitle}
              onSubmit={(e) => {
                e.preventDefault();
                void submitCreate();
              }}
            >
              <div className="ct-dir__formhead">
                <span className="ct-dir__formtitle">{DIRECTORY_COPY.createTitle}</span>
                <button type="button" className="ct-textbtn ct-dir__formclose" disabled={creating} onClick={toggleForm}>
                  {DIRECTORY_COPY.cancel}
                </button>
              </div>
              <TextField
                label={TREE_ENTRY_COPY.treeId}
                required
                value={newId}
                autoFocus
                placeholder="例如 T2、topic-1"
                hint="1–64 位字母、数字、下划线或连字符，首位为字母或数字；同名不会覆盖。"
                onChange={setNewId}
              />
              <TextField
                label={TREE_ENTRY_COPY.rootQuestion}
                required
                multiline
                rows={3}
                value={rootQuestion}
                placeholder="这棵树要回答的那个问题"
                hint="作为新树的唯一根判断，起始为未决、未经人确认。"
                onChange={setRootQuestion}
              />
              <div className="ct-dir__formfoot">
                <Button type="submit" variant="primary" loading={creating} disabled={!canCreate}>
                  {creating ? '创建中…' : DIRECTORY_COPY.createSubmit}
                </Button>
                <span className="ct-dir__formhint">{DIRECTORY_COPY.createHint}</span>
              </div>
            </form>
          )}

          {issue && (
            <p className="ct-dir__error" role="alert">
              {issue}
            </p>
          )}
          {createError && (
            <p className="ct-dir__error" role="alert">
              新建失败：{treeErrorText(createError)}
            </p>
          )}

          {status === 'loading' && (
            <div className="ct-dir__state" role="status">
              {DIRECTORY_COPY.loading}
            </div>
          )}

          {status === 'error' && (
            <div className="ct-dir__state ct-dir__state--error">
              <div className="ct-dir__statetitle">{DIRECTORY_COPY.errorTitle}</div>
              {error && <p className="ct-dir__statedesc">{treeErrorText(error)}</p>}
              <Button size="sm" onClick={onRefresh} loading={refreshing}>
                {DIRECTORY_COPY.retry}
              </Button>
            </div>
          )}

          {status === 'ready' && (
            <>
              {error && (
                <div className="ct-dir__banner" role="status">
                  <span>{treeErrorText(error)}</span>
                  <button type="button" className="ct-textbtn" disabled={refreshing} onClick={onRefresh}>
                    {refreshing ? DIRECTORY_COPY.refreshing : DIRECTORY_COPY.retry}
                  </button>
                </div>
              )}

              {empty && (
                <div className="ct-dir__state ct-dir__state--empty">
                  <div className="ct-dir__statetitle ct-serif">{empty.title}</div>
                  <p className="ct-dir__statedesc">{empty.desc}</p>
                  <Button size="sm" variant="primary" onClick={() => setFormOpen(true)} disabled={!canCreate} autoFocus>
                    {empty.action}
                  </Button>
                </div>
              )}

              {!empty && (
                <ul className="ct-dir__list" aria-label="全部树">
                  {items.map((item) => (
                    <li key={item.treeId}>
                      <button
                        type="button"
                        className="ct-dir__row"
                        disabled={creating}
                        onClick={() => {
                          setCreateError(null);
                          setIssue(null);
                          onOpen(item);
                        }}
                        aria-label={directoryItemTitle(item) + '，树 ' + item.treeId}
                      >
                        <span className="ct-dir__q">{directoryItemTitle(item)}</span>
                        <span className="ct-dir__rowmeta">
                          <span className="ct-mono ct-dir__id" title={item.treeId}>
                            {item.treeId}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {partial.map((treeId) => (
                    <li key={treeId} className="ct-dir__row ct-dir__row--unavailable" aria-disabled="true">
                      <span className="ct-dir__q">{DIRECTORY_COPY.unnamedQuestion}</span>
                      <span className="ct-dir__rowmeta">
                        <span className="ct-dir__unavailable">{DIRECTORY_COPY.unavailableRow}</span>
                        <span className="ct-mono ct-dir__id" title={treeId}>
                          {treeId}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {partial.length > 0 && (
                <p className="ct-dir__partial">
                  {DIRECTORY_COPY.unavailableNote}
                  {partial.map((id) => (
                    <span key={id} className="ct-mono ct-dir__partialid">
                      {id}
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
