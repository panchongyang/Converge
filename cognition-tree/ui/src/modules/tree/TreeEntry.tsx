/**
 * 树的唯一入口：按已知 ID 打开 / 切换，或新建一棵树（树 ID + 根问题）。
 *
 * 职责：渲染同一张表单；空状态与已有树的顶栏都打开它，避免出现第二个建树入口。
 * 状态归属：表单草稿、提交中与失败原因都在本组件；树事实只经 TreeAccess 端口交换。
 * 失败：校验原因与端口业务错误原地显示，不清空已填内容；创建同名树由端口拒绝，不覆盖。
 * 成功：创建返回的树 ID 立即交给 open；环境重新挂载应用并显示新根，本组件随旧树卸载。
 * 边界：不做树列表、改名或删除，也不检查树内容；打开时的存在性与根由环境用 readView 核对。
 */
import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TreeId } from '../../types/kernel';
import type { TreeAccess } from '../../types/ports';
import { Button, TextField } from '../../components';
import { toUiError, type UiError } from '../../utils/errors';
import { TREE_ENTRY_COPY, openTreeIssue, treeDraftIssue, treeErrorText } from './model';
import './tree.css';

/** 一次提交的类型：决定哪个按钮显示请求中。 */
type Busy = 'create' | 'open' | null;

/**
 * 树入口表单。
 * @param props.currentTreeId 本会话当前绑定的树 ID
 * @param props.missing 当前树是否尚不存在（空状态）；只影响提示文案
 * @param props.defaultTreeId 新建树 ID 的初始值；空状态时用当前树 ID，方便补建 T1
 * @param props.access 环境提供的打开/创建能力；失败时抛出带 code 的业务错误
 * @param props.onClose 关闭入口；成功切换后也会调用
 */
export function TreeEntry(props: {
  currentTreeId: TreeId;
  missing?: boolean;
  defaultTreeId?: TreeId;
  access: TreeAccess;
  onClose: () => void;
}) {
  const { access, onClose, currentTreeId } = props;
  const [newId, setNewId] = useState(props.defaultTreeId ?? '');
  const [rootQuestion, setRootQuestion] = useState('');
  const [openId, setOpenId] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [failure, setFailure] = useState<UiError | null>(null);

  /** 清掉上一轮提示，避免旧失败遮住新输入。 */
  const reset = () => {
    setIssue(null);
    setFailure(null);
  };

  /**
   * 执行一次打开/创建；成功后才关闭入口。
   * @param kind 本次动作
   * @param work 端口调用
   */
  const submit = async (kind: Exclude<Busy, null>, work: () => Promise<void>) => {
    reset();
    setBusy(kind);
    try {
      await work();
      onClose();
    } catch (e) {
      setFailure(toUiError(e));
      setBusy(null);
    }
  };

  /** 新建：先做空值检查；字符规则和“同名不覆盖”由环境裁决。 */
  const onCreate = () => {
    const draftIssue = treeDraftIssue({ treeId: newId, rootQuestion });
    if (draftIssue) {
      reset();
      setIssue(draftIssue);
      return;
    }
    void submit('create', async () => {
      const created = await access.create(newId, rootQuestion);
      await access.open(created);
    });
  };

  /** 打开已知树：环境的 open 先核对根，再切换。 */
  const onOpen = () => {
    const openIssue = openTreeIssue(openId);
    if (openIssue) {
      reset();
      setIssue(openIssue);
      return;
    }
    void submit('open', () => access.open(openId));
  };

  /** Esc 只关入口，不把按键交给宿主的全局快捷键。 */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  const hint = props.missing
    ? `当前树 ${currentTreeId} 不存在。可以在下面新建一棵，或打开工作区里已有的树。`
    : `本会话当前显示 ${currentTreeId}。打开已有树不改数据；新建只在树 ID 不存在时生效。`;

  return (
    <div className="ct-treeveil" onMouseDown={onClose}>
      <div
        className="ct-treeentry"
        role="dialog"
        aria-modal="true"
        aria-label="打开或新建树"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="ct-treeentry__head">
          <span className="ct-treeentry__title">打开或新建树</span>
          <button type="button" className="ct-textbtn ct-treeentry__close" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="ct-treeentry__hint">{hint}</p>

        <section className="ct-treeentry__section" aria-label="新建树">
          <div className="ct-treeentry__label">新建一棵树</div>
          <TextField
            label={TREE_ENTRY_COPY.treeId}
            required
            value={newId}
            autoFocus
            placeholder="例如 T1、T2 或 topic-1"
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
          <div className="ct-treeentry__actions">
            <Button variant="primary" loading={busy === 'create'} disabled={busy !== null} onClick={onCreate}>
              {TREE_ENTRY_COPY.create}
            </Button>
          </div>
        </section>

        <div className="ct-treeentry__sep" role="separator">
          或
        </div>

        <section className="ct-treeentry__section" aria-label="打开已有树">
          <div className="ct-treeentry__label">打开工作区里已有的树</div>
          <div className="ct-treeentry__row">
            <TextField
              label={TREE_ENTRY_COPY.treeId}
              value={openId}
              placeholder="已知的树 ID"
              onChange={setOpenId}
            />
            <Button loading={busy === 'open'} disabled={busy !== null} onClick={onOpen}>
              {TREE_ENTRY_COPY.open}
            </Button>
          </div>
          <p className="ct-treeentry__note">只按已知 ID 打开，不列出全部树；不存在或读取失败会在这里说明原因。</p>
        </section>

        {issue && (
          <p className="ct-treeentry__error" role="alert">
            {issue}
          </p>
        )}
        {failure && (
          <p className="ct-treeentry__error" role="alert">
            {treeErrorText(failure)}
          </p>
        )}
      </div>
    </div>
  );
}
