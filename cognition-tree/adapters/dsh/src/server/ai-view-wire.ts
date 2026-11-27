/**
 * 连接同一份 AI 视图表示的两处消费者：worker 用紧凑文本计费，工具默认输出同一表示；
 * 详情模式由工具直出原样 JSON，不经过紧凑投影，避免把节点 detail 压掉。
 * worker 与宿主之间仍传 TreeView；UI 不走这里，内核不认识模型文本的格式。
 */
import type { TreeView } from '@cognition-tree/kernel/types';
import { canCompactAiReadView, compactAiReadView } from './ai-read-view';

/**
 * 交给内核的有界度量；宽页在构造候选前跳过，沿用原 JSON 增量预算。
 * 详情模式不经过这里：内核直接按原样 JSON 精确计费。
 * 不含调用方参数、权限状态或任何读写副作用。
 */
export const aiReadViewCost = {
  canMeasure: canCompactAiReadView,
  /** 只计模型实际得到的文本。@param view 含待返回的边界和游标的候选页。 */
  measure(view: TreeView): number | undefined {
    const text = compactAiReadView(view);
    return text === undefined ? undefined : Buffer.byteLength(text, 'utf8');
  },
};

/**
 * 输出已计费的同一表示；详情模式按本页原样 JSON，紧凑范围外保留原 JSON。
 * @param view worker 返回的规范视图。
 * @param includeDetails true 表示本页每个节点都带 detail，必须原样输出，不能压缩丢字段。
 */
export function renderAiReadView(view: TreeView, includeDetails = false): string {
  if (includeDetails) return JSON.stringify(view);
  return compactAiReadView(view) ?? JSON.stringify(view);
}
