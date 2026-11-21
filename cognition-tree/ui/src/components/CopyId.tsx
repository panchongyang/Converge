/**
 * 「复制 ID」：人不用看见稳定 ID，点一下就能把它交给 AI。
 *
 * 只复制文本；成功与失败都在原地换文案，不弹提示、不新增浮层。
 * 文案约 1.2 秒后回到「复制 ID」，期间重复点击会重新计时。
 */
import { useEffect, useRef, useState } from 'react';
import type { NodeId } from '../types/kernel';
import { copyText } from '../utils/clipboard';

/** 复制结果：idle 未点过，copied 已写入剪贴板，failed 写入失败。 */
type CopyState = 'idle' | 'copied' | 'failed';

/**
 * 阅读栏里的「复制 ID」文字按钮。
 * @param props.id 当前判断的稳定 ID；按钮只把它写进剪贴板，不在界面上显示
 */
export function CopyId(props: { id: NodeId }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await copyText(props.id);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1200);
  };

  return (
    <button type="button" className="ct-textbtn ct-copyid" onClick={() => void onClick()} title="把这个判断的 ID 复制给 AI 使用">
      {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制 ID'}
    </button>
  );
}
