/**
 * 侧栏的“全部树”视图：把目录读取、进入与新建接到当前可信会话上。
 *
 * 职责：
 * - 挂载时读一次目录，返回/重开由父层重新挂载再读；手动刷新也只多读一次，不后台轮询。
 * - 行里已有服务端报告的实际根，直接交给父层进入，不再逐树 readView(root)。
 * - 新建只发 createTree；成功后根 ID 按契约等于树 ID，直接进入，不把读根失败误报成新建失败。
 * 状态归属：目录与读取失败都在本组件；创建进度在表单组件。会话变化由父层换 key 重挂，
 * 迟到的目录/创建响应用序号与挂载标记丢弃，不会写进别的会话或视图。
 * 边界：不做删除、改名、AI 入口，也不缓存树内容；不显示会话 UUID。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TreeDirectory } from '@cognition-tree/ui/app';
import type { NodeId, TreeId } from '@cognition-tree/kernel/types';
import type { CognitionClient } from '@cognition-tree/ui/types/ports';
import { createAndEnter } from './tree-entry';
import { createCognitionClient } from './transport';
import {
  readTreeDirectory,
  toDirectoryError,
  type DirectoryError,
  type TreeDirectory as TreeDirectoryData,
} from './tree-directory';

/** 目录读取的界面状态；refreshing 与 status 分开，刷新时保留已有列表。 */
interface DirectoryState {
  status: 'loading' | 'ready' | 'error';
  items: TreeDirectoryData['trees'];
  unavailable: string[];
  error: DirectoryError | null;
  refreshing: boolean;
}

/** 初次挂载或换会话后的状态：只显示读取中，不沿用上一个会话的条目。 */
const INITIAL: DirectoryState = { status: 'loading', items: [], unavailable: [], error: null, refreshing: false };

/**
 * 目录视图。
 * @param props.sessionId 可信会话；本组件只以它创建客户端与读目录
 * @param props.onEnter 进入目标树的回调；父层校验会话后切换到三栏
 */
export function DirectoryPanel(props: { sessionId: string; onEnter: (treeId: TreeId, rootId: NodeId) => void }) {
  const { sessionId, onEnter } = props;
  const client = useMemo<CognitionClient>(() => createCognitionClient({ sessionId }), [sessionId]);
  const [state, setState] = useState<DirectoryState>(INITIAL);
  const loadSeq = useRef(0);
  const createSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * 读一次目录。
   * @param mode initial 用于首次状态，refresh 保留已有列表并显示刷新中
   */
  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const seq = ++loadSeq.current;
      setState((prev) =>
        mode === 'refresh' && prev.status === 'ready'
          ? { ...prev, refreshing: true, error: null }
          : { ...prev, status: 'loading', error: null, refreshing: mode === 'refresh' },
      );
      try {
        const next = await readTreeDirectory(sessionId);
        if (!mounted.current || seq !== loadSeq.current) return;
        setState({ status: 'ready', items: next.trees, unavailable: next.unavailable, error: null, refreshing: false });
      } catch (e) {
        if (!mounted.current || seq !== loadSeq.current) return;
        const error = toDirectoryError(e);
        setState((prev) =>
          prev.status === 'ready' && prev.items.length + prev.unavailable.length > 0
            ? { ...prev, refreshing: false, error }
            : { status: 'error', items: [], unavailable: [], error, refreshing: false },
        );
      }
    },
    [sessionId],
  );

  // 首次挂载即读；会话变化时父层换 key 重挂，不会把旧工作区的目录带过来。
  useEffect(() => {
    void load('initial');
  }, [load]);

  /** 手动刷新；错误态、空态与“别的会话刚建了树”都走这里重读。 */
  const refresh = useCallback(() => {
    void load('refresh');
  }, [load]);

  /**
   * 新建：createTree 成功后按契约以 treeId 作为新根直接进入。
   * 失败原样抛给表单显示；表单会放开下次提交，可原地重试。
   */
  const create = useCallback(
    async (treeId: string, rootQuestion: string) => {
      const token = ++createSeq.current;
      await createAndEnter(client, treeId, rootQuestion, (created, rootId) => {
        if (!mounted.current || token !== createSeq.current) return;
        onEnter(created, rootId);
      });
    },
    [client, onEnter],
  );

  return (
    <TreeDirectory
      status={state.status}
      items={state.items}
      unavailable={state.unavailable}
      error={state.error}
      refreshing={state.refreshing}
      onRefresh={refresh}
      onOpen={(item) => onEnter(item.treeId, item.rootId)}
      onCreate={create}
    />
  );
}
