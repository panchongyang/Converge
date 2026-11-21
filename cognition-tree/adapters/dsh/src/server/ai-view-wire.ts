/**
 * 连接同一份 AI 视图表示的两处消费者：worker 用它计费，工具用它给模型输出。
 * worker 与宿主之间仍传 TreeView；UI 不走这里，内核不认识模型文本的格式。
 */
import type { TreeView } from '@cognition-tree/kernel/types';
import { canCompactAiReadView, compactAiReadView } from './ai-read-view';

/**
 * 交给内核的有界度量；宽页在构造候选前跳过，沿用原 JSON 增量预算。
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

/** 输出已计费的同一表示；紧凑范围外保留原 JSON。@param view worker 返回的规范视图。 */
export function renderAiReadView(view: TreeView): string {
  return compactAiReadView(view) ?? JSON.stringify(view);
}
