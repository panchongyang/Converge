/**
 * 时间线：按发生时间倒序列出修订。形成记录（长出、剪除、重新启用、替代）与单纯的「人确认」
 * 分开标注；「人确认」条目带朱印，导入的手稿记录标「导入」。阅读、展开、折叠不写修订，所以不在其中。
 * 悬停一条修订会在空间里点亮相关判断。
 */
import type { NodeId, Revision, TreeId, ViewNode } from '../../types/kernel';
import type { CognitionClient } from '../../types/ports';
import { useHistory } from '../../models/useNodeReads';
import { detailPrevious, detailReason, detailReviveWhen, formatAt, revisionAction, revisionActionLabel, revisionActorLabel } from '../../utils/labels';
import { Button, NodeChip, Seal } from '../../components';
import './timeline.css';

export interface TimelineProps {
  client: CognitionClient;
  treeId: TreeId;
  /** 树版本；变化时从最新一页重读。 */
  stamp: number;
  /** 只看与该节点关联的修订；省略表示整棵树。 */
  nodeId?: NodeId;
  known: Map<NodeId, ViewNode>;
  /** 嵌在阅读栏里时的紧凑样式。 */
  compact?: boolean;
  onSelect: (id: NodeId) => void;
  onHighlight: (ids: NodeId[]) => void;
}

/**
 * 时间线视图。
 * @param p 见 TimelineProps
 */
export function Timeline(p: TimelineProps) {
  const h = useHistory(p.client, p.treeId, p.nodeId, p.stamp, 20);
  if (h.error) return <div className="ct-banner ct-banner--danger">时间线读取失败：{h.error.message}</div>;
  if (h.items.length === 0) {
    return h.loading ? (
      <div className="ct-tl is-loading">读取中…</div>
    ) : (
      <p className="ct-tl__empty">还没有修订。只有改变认知的动作才写进时间线；阅读与展开不会。</p>
    );
  }
  const groups: { day: string; items: Revision[] }[] = [];
  for (const r of h.items) {
    const day = r.at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(r);
    else groups.push({ day, items: [r] });
  }
  return (
    <div className={'ct-tl' + (p.compact ? ' is-compact' : '')}>
      {!p.compact && (
        <p className="ct-tl__legend">
          <span className="ct-tl__kind is-formation">形成</span>树如何长出、剪除、重新启用或被替代
          <span className="ct-tl__kind is-confirmation">人确认</span>只改变确认程度，不改树形
        </p>
      )}
      {groups.map((g) => (
        <section key={g.day} className="ct-tl__day">
          <div className="ct-tl__date ct-mono">{g.day}</div>
          <ol className="ct-tl__list">
            {g.items.map((r) => (
              <RevisionItem key={r.id} r={r} known={p.known} onSelect={p.onSelect} onHighlight={p.onHighlight} />
            ))}
          </ol>
        </section>
      ))}
      {h.hasMore && (
        <Button size="sm" variant="ghost" loading={h.loading} onClick={h.loadMore}>
          加载更早的修订
        </Button>
      )}
    </div>
  );
}

/**
 * 一条修订。
 * @param props.r 修订
 * @param props.known 已读节点，用于在 ID 旁显示标题
 * @param props.onSelect 点 ID 时选中该判断
 * @param props.onHighlight 悬停时点亮相关判断，离开时传空数组
 */
function RevisionItem(props: {
  r: Revision;
  known: Map<NodeId, ViewNode>;
  onSelect: (id: NodeId) => void;
  onHighlight: (ids: NodeId[]) => void;
}) {
  const { r } = props;
  const action = revisionAction(r);
  const confirmation = r.kind === 'confirmation';
  const imported = r.by === 'import';
  const previousPrune = detailPrevious(r);
  const reason = detailReason(r);
  const reviveWhen = detailReviveWhen(r);
  const previous =
    previousPrune &&
    [previousPrune.pruneReason && '理由：' + previousPrune.pruneReason, previousPrune.reviveWhen && '复活条件：' + previousPrune.reviveWhen]
      .filter(Boolean)
      .join('；');
  return (
    <li
      className={'ct-tl__item is-' + action + ' by-' + r.by}
      onMouseEnter={() => props.onHighlight(r.nodeIds)}
      onMouseLeave={() => props.onHighlight([])}
    >
      <div className="ct-tl__head">
        <span className="ct-tl__action">{revisionActionLabel(r)}</span>
        <span className={'ct-tl__kind is-' + (confirmation ? 'confirmation' : 'formation')}>{confirmation ? '人确认' : '形成'}</span>
        {confirmation && <Seal size={12} />}
        {imported && <span className="ct-tl__import">导入</span>}
        <span className="ct-tl__by">{revisionActorLabel(r.by)}</span>
        <span className="ct-tl__at ct-mono">{formatAt(r)}</span>
      </div>
      <p className="ct-tl__summary">{r.summary}</p>
      {reason && (
        <p className="ct-tl__detail">
          <span className="ct-tl__detail-key">理由</span>
          {reason}
        </p>
      )}
      {reviveWhen && (
        <p className="ct-tl__detail">
          <span className="ct-tl__detail-key">复活条件</span>
          {reviveWhen}
        </p>
      )}
      {previous && (
        <p className="ct-tl__detail is-previous">
          <span className="ct-tl__detail-key">此前</span>
          {previous}
        </p>
      )}
      <div className="ct-tl__nodes">
        {r.nodeIds.map((id) => (
          <NodeChip key={id} id={id} title={props.known.get(id)?.title} onClick={props.onSelect} />
        ))}
      </div>
      {r.source && <div className="ct-tl__source">出处：{r.source}</div>}
    </li>
  );
}
