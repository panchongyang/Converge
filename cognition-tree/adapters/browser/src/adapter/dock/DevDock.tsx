/**
 * 浏览器开发坞：只在独立网页出现的开发工具，DSH 嵌入时没有它。
 *
 * - AI 模拟器：以 AI 身份调用正式操作目录，制造提议与日常变更（预设场景或自拟）。
 *   它不能生成“人确认”：catalog 会拒绝 confirm，这里只记录结果（按预期被拒绝 / 与预期不符）。
 * - 存储与预算：已提交版本、测试存储真实字节、最近一次 readView 实际返回的节点/引用/字节与所用预算；
 *   模拟延迟、让下一次保存失败、清空测试存储。
 * - 外观：跟随系统 / 纸本 / 夜读，写在 html 与 UI 根上，只换令牌。
 * 状态归属：记录、表单、外观选择是本组件的本地状态；树数据只经内核读写。
 */
import { useState, useSyncExternalStore } from 'react';
import type { BranchState, Draft, NodeId, Placement, RefKind } from '@cognition-tree/kernel/types';
import type { DockContext } from '@cognition-tree/ui/types/ports';
import { Button, NodeChip, Segmented, TextField } from '@cognition-tree/ui/components';
import type { BrowserEnv } from '../env';
import { SCENARIOS, type Scenario } from '../simulator/scenarios';
import { applyTheme, readTheme, type ThemeChoice } from './theme';
import './dock.css';

interface LogEntry {
  id: number;
  at: string;
  title: string;
  /** ok：按预期保存；rejected：按预期被拒绝；unexpected：与预期不符。 */
  outcome: 'ok' | 'rejected' | 'unexpected';
  detail: string;
  nodeId?: NodeId;
}

type PlaceKind = 'branch' | 'supplement' | 'erratum' | 'replacement';
const PLACE_LABEL: Record<PlaceKind, string> = { branch: '新分支', supplement: '补充', erratum: '勘误', replacement: '替代' };

/**
 * 把异常整理成一句说明。
 * @param e 内核或运行时抛出的值
 */
function describe(e: unknown): string {
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : 'unknown';
  return code + '：' + (e instanceof Error ? e.message : String(e));
}

/**
 * 开发坞。
 * @param props.ctx UI 给出的只读上下文（选中、已读节点）
 * @param props.env 浏览器环境（AI 调用点、存储控制与出处阅读器）
 */
export function DevDock(props: { ctx: DockContext; env: BrowserEnv }) {
  const { ctx, env } = props;
  useSyncExternalStore(env.dev.subscribe, env.dev.version);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme());
  const [confirmClear, setConfirmClear] = useState(false);

  const record = (e: Omit<LogEntry, 'id' | 'at'>) =>
    setLog((l) => [{ ...e, id: Date.now() + Math.random(), at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }, ...l].slice(0, 8));

  const runScenario = async (s: Scenario) => {
    setRunning(s.id);
    try {
      const r = await s.run(env.ai, ctx.treeId, ctx.selectedId);
      record({ title: s.title, outcome: s.expect === 'accepted' ? 'ok' : 'unexpected', detail: r.detail, nodeId: r.nodeId });
    } catch (e) {
      record({ title: s.title, outcome: s.expect === 'rejected' ? 'rejected' : 'unexpected', detail: describe(e) });
    } finally {
      setRunning(null);
    }
  };

  const stamp = env.dev.stamp();
  const read = env.dev.lastRead();
  const latency = env.dev.latency();
  const armed = env.dev.armed();

  const chooseTheme = (t: ThemeChoice) => {
    applyTheme(t);
    setTheme(t);
  };

  return (
    <div className="ct-dev">
      <section className="ct-dev__col is-sim" aria-label="AI 模拟器">
        <header className="ct-dev__head">
          <span className="ct-dev__title">AI 模拟器</span>
          <span className="ct-dev__sub">以 AI 身份调用操作目录；不能替人确认</span>
          <button type="button" className="ct-textbtn" onClick={() => setComposing((c) => !c)}>
            {composing ? '收起自拟' : '自拟提议'}
          </button>
        </header>
        {composing ? (
          <Composer ctx={ctx} env={env} onResult={record} />
        ) : (
          <div className="ct-dev__scenarios">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={'ct-dev__scenario is-' + s.expect + (running === s.id ? ' is-running' : '')}
                disabled={running !== null}
                onClick={() => void runScenario(s)}
              >
                <span className="ct-dev__scenario-kind">{s.kind}</span>
                <span className="ct-dev__scenario-title">{s.title}</span>
                <span className="ct-dev__scenario-desc">{s.description}</span>
              </button>
            ))}
          </div>
        )}
        {log.length > 0 && (
          <ol className="ct-dev__log" aria-label="AI 调用记录">
            {log.map((e) => (
              <li key={e.id} className={'ct-dev__log-item is-' + e.outcome}>
                <span className="ct-dev__log-at ct-mono">{e.at}</span>
                <span className="ct-dev__log-title">{e.title}</span>
                <span className="ct-dev__log-detail">
                  {e.outcome === 'rejected' ? '按预期被拒绝 · ' : e.outcome === 'unexpected' ? '与预期不符 · ' : ''}
                  {e.detail}
                </span>
                {e.nodeId && <NodeChip id={e.nodeId} onClick={ctx.select} />}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="ct-dev__col is-panel" aria-label="存储与预算">
        <header className="ct-dev__head">
          <span className="ct-dev__title">存储与预算</span>
        </header>
        <dl className="ct-dev__stats">
          <div>
            <dt>树</dt>
            <dd>
              {ctx.treeId} · {stamp === null ? '不存在' : 'v' + stamp}
            </dd>
          </div>
          <div>
            <dt>测试存储</dt>
            <dd>{(env.dev.storageBytes() / 1024).toFixed(1)} KB · localStorage</dd>
          </div>
          <div>
            <dt>最近视野读取</dt>
            <dd>
              {read
                ? '节点 ' + read.nodes + ' · 引用 ' + read.refs + ' · ' + (read.bytes / 1024).toFixed(1) + ' KB · ' + read.boundaries + ' 处边界 · ' + (read.complete ? '范围完整' : '有未读')
                : '—'}
            </dd>
          </div>
          <div>
            <dt>本次读取的预算</dt>
            <dd>
              {read
                ? '扫描 ≤' + read.budget.maxScans + ' · 节点 ≤' + read.budget.maxNodes + ' · 字节 ≤' + (read.budget.maxBytes / 1024).toFixed(1) + ' KB · ' + (read.onLimit === 'fold' ? '超限折叠' : '超限报错')
                : '—'}
            </dd>
          </div>
        </dl>

        <div className="ct-dev__ctl">
          <span className="ct-dev__label">模拟延迟</span>
          <Segmented
            size="sm"
            ariaLabel="模拟延迟"
            value={String(latency)}
            onChange={(v) => env.dev.setLatency(Number(v))}
            options={[
              { value: '0', label: '无' },
              { value: '400', label: '0.4 s' },
              { value: '1500', label: '1.5 s' },
            ]}
          />
        </div>
        <div className="ct-dev__ctl">
          <Button size="sm" variant="danger" active={armed} disabled={armed} onClick={() => env.dev.armFailure()}>
            {armed ? '下一次保存将失败…' : '让下一次保存失败'}
          </Button>
          <button
            type="button"
            className="ct-textbtn"
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                window.setTimeout(() => setConfirmClear(false), 4000);
                return;
              }
              env.dev.clear();
              window.location.reload();
            }}
          >
            {confirmClear ? '再点一次确认清空' : '清空测试存储'}
          </button>
        </div>

        <div className="ct-dev__ctl is-theme">
          <span className="ct-dev__label">外观</span>
          <Segmented
            size="sm"
            ariaLabel="外观"
            value={theme}
            onChange={chooseTheme}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'paper', label: '纸本' },
              { value: 'ink', label: '夜读' },
            ]}
          />
        </div>
        <p className="ct-dev__note">
          数字是 readView 实际返回的节点/引用/字节与测试存储实际占用；内核未公布扫描计数，这里不编造，也不是负载结论。测试存储与 DSH 的 .converge/ 数据隔离。
        </p>
      </section>
    </div>
  );
}

/**
 * 自拟提议：以 AI 身份新增一条判断。只做最基本的必填提示，其余规则由内核校验并给出原因。
 * @param props.ctx UI 上下文（默认落点取选中的判断）
 * @param props.env 浏览器环境
 * @param props.onResult 把结果写进记录
 */
function Composer(props: { ctx: DockContext; env: BrowserEnv; onResult: (e: Omit<LogEntry, 'id' | 'at'>) => void }) {
  const { ctx, env } = props;
  const [kind, setKind] = useState<PlaceKind>('supplement');
  const [target, setTarget] = useState<string>(ctx.selectedId ?? 'T1');
  const [title, setTitle] = useState('');
  const [basis, setBasis] = useState('');
  const [state, setState] = useState<BranchState>('open');
  const [pruneReason, setPruneReason] = useState('');
  const [reviveWhen, setReviveWhen] = useState('');
  const [refKind, setRefKind] = useState<RefKind | 'none'>('none');
  const [refTarget, setRefTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const t = target.trim();
    const placement: Placement = kind === 'replacement' ? { replacesId: t } : { parentId: t, kind };
    const draft: Draft = {
      body: basis.trim() ? { title: title.trim(), basis: basis.trim() } : { title: title.trim() },
      state,
      refs:
        refKind === 'none' || !refTarget.trim()
          ? []
          : [
              {
                kind: refKind,
                target: ctx.nodes.has(refTarget.trim())
                  ? { nodeId: refTarget.trim() }
                  : { doc: refTarget.trim() },
              },
            ],
      ...(state === 'prune' ? { pruneReason: pruneReason.trim(), reviveWhen: reviveWhen.trim() } : {}),
    };
    setBusy(true);
    try {
      const nodeId = await env.ai.call('addBranch', { treeId: ctx.treeId, placement, draft });
      props.onResult({ title: '自拟' + PLACE_LABEL[kind] + '：' + title.trim(), outcome: 'ok', detail: '已保存为「AI 执行 · 未确认」：' + nodeId, nodeId });
      setTitle('');
      setBasis('');
    } catch (e) {
      props.onResult({ title: '自拟' + PLACE_LABEL[kind] + '：' + title.trim(), outcome: 'unexpected', detail: '被内核拒绝 · ' + describe(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ct-dev__composer">
      <div className="ct-dev__row">
        <Segmented
          size="sm"
          ariaLabel="落点"
          value={kind}
          onChange={setKind}
          options={(Object.keys(PLACE_LABEL) as PlaceKind[]).map((k) => ({ value: k, label: PLACE_LABEL[k] }))}
        />
        <label className="ct-dev__target">
          {kind === 'replacement' ? '被替代的判断' : '挂在'}
          <input className="ct-input ct-mono" list="ct-dev-nodes" value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        {ctx.selectedId && ctx.selectedId !== target && (
          <button type="button" className="ct-textbtn" onClick={() => setTarget(ctx.selectedId as string)}>
            用选中的 {ctx.selectedId}
          </button>
        )}
        <datalist id="ct-dev-nodes">
          {[...ctx.nodes.keys()].map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      </div>
      <div className="ct-dev__grid">
        <TextField label="判断" required value={title} onChange={setTitle} placeholder="一句话写出 AI 提出的判断" />
        <TextField label="依据" value={basis} onChange={setBasis} placeholder="为什么（可选）" />
      </div>
      <div className="ct-dev__row">
        <span className="ct-dev__label">分支状态</span>
        <Segmented
          size="sm"
          ariaLabel="分支状态"
          value={state}
          onChange={setState}
          options={[
            { value: 'keep', label: '留' },
            { value: 'open', label: '未决' },
            { value: 'prune', label: '剪' },
          ]}
        />
        <span className="ct-dev__label">引用</span>
        <select className="ct-select ct-dev__select" value={refKind} onChange={(e) => setRefKind(e.target.value as RefKind | 'none')}>
          <option value="none">无</option>
          <option value="premise">依赖前提</option>
          <option value="example">同类实例</option>
          <option value="conflict">与事实冲突</option>
        </select>
        {refKind !== 'none' && (
          <input
            className="ct-input ct-dev__ref"
            list="ct-dev-nodes"
            value={refTarget}
            onChange={(e) => setRefTarget(e.target.value)}
            placeholder="节点 ID，或仓库内材料路径"
          />
        )}
      </div>
      {state === 'prune' && (
        <div className="ct-dev__grid">
          <TextField label="剪除理由" required value={pruneReason} onChange={setPruneReason} />
          <TextField label="复活条件" required value={reviveWhen} onChange={setReviveWhen} />
        </div>
      )}
      <div className="ct-dev__row is-end">
        <span className="ct-dev__note">其余规则（落点、依赖前提不能指向祖先、剪除须有理由与复活条件等）由内核校验。</span>
        <Button size="sm" variant="primary" loading={busy} disabled={!title.trim() || !target.trim()} onClick={() => void submit()}>
          以 AI 身份提交
        </Button>
      </div>
    </div>
  );
}
