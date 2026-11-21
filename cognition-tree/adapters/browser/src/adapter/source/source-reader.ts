/**
 * 出处阅读器的状态（浏览器宿主能力）：打开哪份材料、读到哪一步。
 * 开发模式下经 Vite 的 /@fs/ 读取仓库里的文件（vite.config.ts 放行仓库根）；独立构建没有材料服务，只报路径。
 * 只为显示而读，不改树；fetch 发生在适配层，UI 内核不直接发请求。
 */

export interface SourceState {
  open: boolean;
  /** 仓库相对路径或 http(s) 地址。 */
  doc: string;
  /** 材料里的局部，例如 “E02”；阅读器会高亮并滚到第一处。 */
  part?: string;
  status: 'loading' | 'ready' | 'error';
  text?: string;
  error?: string;
}

export interface SourceReaderStore {
  subscribe(listener: () => void): () => void;
  get(): SourceState;
  /**
   * 打开一份材料；读完（或失败）时兑现。失败只体现在阅读器里，不抛给调用方。
   * @param doc 仓库相对路径或 http(s) 地址
   * @param part 可选的局部
   */
  open(doc: string, part?: string): Promise<void>;
  close(): void;
  /** 原文的地址（开发模式下可在新标签打开）；独立构建返回 null。 */
  url(doc: string): string | null;
}

/**
 * 创建阅读器状态。
 * @param repoRoot Converge 仓库根（正斜杠）
 */
export function createSourceReader(repoRoot: string): SourceReaderStore {
  let state: SourceState = { open: false, doc: '', status: 'loading' };
  const listeners = new Set<() => void>();
  const set = (s: SourceState) => {
    state = s;
    for (const l of [...listeners]) l();
  };
  const root = repoRoot.replace(/\/?$/, '/');
  const url = (doc: string): string | null => {
    if (/^https?:/i.test(doc)) return doc;
    if (!import.meta.env.DEV) return null;
    return '/@fs/' + encodeURI(root + doc.replace(/^\.?\//, ''));
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => state,
    url,
    close() {
      set({ ...state, open: false });
    },
    async open(doc, part) {
      set({ open: true, doc, part, status: 'loading' });
      const u = url(doc);
      if (/^https?:/i.test(doc)) {
        window.open(doc, '_blank', 'noopener');
        set({ ...state, open: false });
        return;
      }
      if (!u) {
        set({ open: true, doc, part, status: 'error', error: '独立构建没有材料服务；用 pnpm dev 启动开发模式才能在页内读取仓库里的研究材料。' });
        return;
      }
      try {
        const res = await fetch(u);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        if (state.doc === doc && state.open) set({ open: true, doc, part, status: 'ready', text });
      } catch (e) {
        if (state.doc === doc && state.open) {
          set({ open: true, doc, part, status: 'error', error: '没能读取 ' + doc + '：' + (e instanceof Error ? e.message : String(e)) });
        }
      }
    },
  };
}
