/**
 * 渲染带出处链接的正文：[标签](路径) 变成可点击的出处，经 HostBridge 打开；其余原样显示。
 */
import { Fragment } from 'react';
import { parseRich } from '../utils/rich-text';
import { Icon } from './Icon';

/**
 * 渲染一段正文。
 * @param props.text 正文
 * @param props.onOpenSource 点击出处时调用，参数为仓库相对路径；不给时出处显示为纯文字
 */
export function RichText(props: { text: string; onOpenSource?: (doc: string) => void }) {
  return (
    <>
      {parseRich(props.text).map((seg, i) =>
        seg.type === 'text' ? (
          <Fragment key={i}>{seg.text}</Fragment>
        ) : props.onOpenSource ? (
          <button
            key={i}
            type="button"
            className="ct-source"
            title={'打开出处：' + seg.doc}
            onClick={(e) => {
              // 出处链接嵌在可展开的行里：只打开材料，不触发所在行的展开。
              e.stopPropagation();
              props.onOpenSource?.(seg.doc);
            }}
          >
            <Icon name="doc" size={12} />
            {seg.label}
          </button>
        ) : (
          <span key={i} className="ct-source" title={seg.doc}>
            {seg.label}
          </span>
        ),
      )}
    </>
  );
}
