/**
 * 状态行与视野参数句。
 *
 * 常显只有三件事：全景或聚焦、视野里判断数、阅读方式。点视野词或阅读方式，参数句在状态行上方
 * 原地展开；参数值带下划线，点一下改成下一档（原型用原生下拉，立即重读）。改参数只改阅读范围，不写树。
 * 读取失败时在状态行上方显示一行说明，视野保持上一次成功的结果，可改为折叠。
 */
import type { ReactNode } from 'react';
import type { Depth, Expand, NodeId } from '../../types/kernel';
import { compareIds } from '../../utils/ids';
import { BUDGETS, DEFAULT_FOCUS_EXPAND, type ViewSpec } from '../../models/useCognition';
import type { UiError } from '../../utils/errors';
import './view.css';

export type ReadMode = 'space' | 'combo' | 'outline';

export const MODE_LABEL: Record<ReadMode, string> = {
  space: '空间',
  combo: '空间+大纲',
  outline: '大纲',
};

const DIRECTION_LABEL = { out: '出向', in: '入向', both: '双向' } as const;
const DEPTH_VALUES: Depth[] = [0, 1, 2, 'leaf'];
const depthText = (d: Depth) => (d === 'leaf' ? '到叶' : String(d));

export interface ViewBarProps {
  spec: ViewSpec;
  selectedId: NodeId | null;
  rootId: NodeId;
  known: Map<NodeId, { title: string }>;
  visibleCount: number;
  /** 边界的汇总说明；没有边界时为 null。 */
  note: string | null;
  mode: ReadMode;
  viewOpen: boolean;
  modeOpen: boolean;
  onToggleView: () => void;
  onToggleMode: () => void;
  onMode: (m: ReadMode) => void;
  onSpec: (s: ViewSpec) => void;
  onFit: () => void;
  viewError: UiError | null;
  onDismissError: () => void;
}

/**
 * 空间底部的状态行。
 * @param p 见 ViewBarProps
 */
export function ViewBar(p: ViewBarProps) {
  const f = p.spec.kind === 'focus' ? p.spec : null;
  const focusId = f?.focusId ?? p.selectedId ?? p.rootId;
  const ids = [...p.known.keys()].sort(compareIds);
  const toFocus = (id: NodeId) =>
    p.onSpec({
      kind: 'focus',
      focusId: id,
      expand: f?.expand ?? DEFAULT_FOCUS_EXPAND,
      budget: f?.budget ?? BUDGETS.medium,
      onLimit: f?.onLimit ?? 'fold',
    });
  const patch = (e: Partial<Expand>) => {
    if (f) p.onSpec({ ...f, expand: { ...f.expand, ...e } });
  };

  return (
    <div className="ct-status">
      {p.viewError && (
        <div className="ct-status__error" role="alert">
          这次读取没有成功：{p.viewError.message}。视野保持上一次成功的结果。
          {f && f.onLimit === 'exact' && (
            <button type="button" className="ct-link" onClick={() => p.onSpec({ ...f, onLimit: 'fold' })}>
              改为折叠
            </button>
          )}
          <button type="button" className="ct-textbtn ct-status__dismiss" onClick={p.onDismissError}>
            知道了
          </button>
        </div>
      )}

      {p.modeOpen && (
        <div className="ct-modeline" role="group" aria-label="阅读方式">
          {(['space', 'combo', 'outline'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={'ct-textbtn' + (m === p.mode ? ' is-on' : '')}
              aria-pressed={m === p.mode}
              onClick={() => p.onMode(m)}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
          <span className="ct-status__hint">按 1 / 2 / 3 切换</span>
        </div>
      )}

      {p.viewOpen && (
        <div className="ct-viewline" role="group" aria-label="视野参数">
          {f ? (
            <span>
              以
              <Select value={f.focusId} onChange={toFocus} ariaLabel="焦点判断">
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
              为焦点，向下
              <Select value={String(f.expand.subtreeDepth)} onChange={(v) => patch({ subtreeDepth: parseDepth(v) })} ariaLabel="子树深度">
                {DEPTH_VALUES.map((d) => (
                  <option key={String(d)} value={String(d)}>
                    {depthText(d)}
                  </option>
                ))}
              </Select>
              层，沿引用
              <Select value={String(f.expand.jumpHops)} onChange={(v) => patch({ jumpHops: Number(v) })} ariaLabel="引用跳数">
                {[0, 1, 2].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </Select>
              跳（
              <Select value={f.expand.direction} onChange={(v) => patch({ direction: v as 'out' | 'in' | 'both' })} ariaLabel="引用方向">
                {(['out', 'in', 'both'] as const).map((d) => (
                  <option key={d} value={d}>
                    {DIRECTION_LABEL[d]}
                  </option>
                ))}
              </Select>
              ，
              <Select
                value={f.expand.jumpFrom}
                onChange={(v) => patch({ jumpFrom: v as 'anchor' | 'expanded' })}
                ariaLabel="起跳范围"
              >
                <option value="anchor">仅焦点</option>
                <option value="expanded">含展开</option>
              </Select>
              ，跳后
              <Select value={String(f.expand.afterJumpDepth)} onChange={(v) => patch({ afterJumpDepth: parseDepth(v) })} ariaLabel="跳后深度">
                {DEPTH_VALUES.map((d) => (
                  <option key={String(d)} value={String(d)}>
                    {depthText(d)}
                  </option>
                ))}
              </Select>
              层），预算
              <Select value={budgetKey(f.budget)} onChange={(v) => f && p.onSpec({ ...f, budget: BUDGETS[v as keyof typeof BUDGETS] })} ariaLabel="预算档位">
                <option value="wide">宽松</option>
                <option value="medium">适中</option>
                <option value="tight">紧</option>
              </Select>
              · 扫描 {f.budget.maxScans} · 节点 {f.budget.maxNodes} · 字节 {Math.round(f.budget.maxBytes / 1000)} KB，超出时
              <Select value={f.onLimit} onChange={(v) => p.onSpec({ ...f, onLimit: v as 'fold' | 'exact' })} ariaLabel="超出预算时">
                <option value="fold">折叠</option>
                <option value="exact">报错</option>
              </Select>
              。{' '}
              <button type="button" className="ct-link" onClick={() => p.onSpec({ kind: 'panorama' })}>
                回到全景
              </button>
            </span>
          ) : (
            <span>
              全景：从根读到叶子，沿每个判断的引用跳一跳。要收窄范围，以
              <Select value={focusId} onChange={toFocus} ariaLabel="聚焦判断">
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
              为焦点折出局部树。
            </span>
          )}
        </div>
      )}

      <div className="ct-status__row">
        <span className="ct-status__left">
          <button type="button" className="ct-textbtn" onClick={p.onToggleView} aria-expanded={p.viewOpen}>
            {p.spec.kind === 'panorama' ? '全景' : '聚焦 ' + p.spec.focusId}
          </button>
          <span className="ct-status__dot">·</span>
          <span>{p.visibleCount} 个判断</span>
          {p.note && (
            <>
              <span className="ct-status__dot">·</span>
              <span>{p.note}</span>
            </>
          )}
          <span className="ct-status__dot">·</span>
          <button type="button" className="ct-textbtn" onClick={p.onToggleMode} aria-expanded={p.modeOpen}>
            {MODE_LABEL[p.mode]}
          </button>
        </span>
        {p.mode !== 'outline' && (
          <button type="button" className="ct-textbtn ct-status__fit" onClick={p.onFit} title="看全视野（F）">
            看全 F
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 下划线值：点开是原生下拉，选中即应用。
 * @param props.value 当前值
 * @param props.onChange 新值
 * @param props.children 选项
 * @param props.ariaLabel 无障碍名称
 */
function Select(props: { value: string; onChange: (v: string) => void; children: ReactNode; ariaLabel: string }) {
  return (
    <span className="ct-inlineval">
      <select
        className="ct-inlineval__select"
        value={props.value}
        aria-label={props.ariaLabel}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.children}
      </select>
    </span>
  );
}

/**
 * 深度选项文本转回 Depth。
 * @param v 选项值
 */
function parseDepth(v: string): Depth {
  return v === 'leaf' ? 'leaf' : Number(v);
}

/**
 * 预算对象对应的档位名。
 * @param b 预算
 */
function budgetKey(b: { maxScans: number; maxNodes: number; maxBytes: number }): keyof typeof BUDGETS {
  for (const key of Object.keys(BUDGETS) as (keyof typeof BUDGETS)[]) {
    if (BUDGETS[key] === b) return key;
  }
  return 'medium';
}
