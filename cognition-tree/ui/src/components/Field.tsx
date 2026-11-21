/**
 * 带标签的文本输入：只有一条极淡的底线，无边框、无底色。给开发坞的自拟提议用。
 * 输入只有一条极淡的底线；是否必填写在标签里，提交前由调用方与内核各自校验。
 */
import { useId } from 'react';

/**
 * 文本字段（单行或多行）。
 * @param props.label 字段名
 * @param props.value 当前文本
 * @param props.onChange 文本变化时调用
 * @param props.required 是否必填（只做提示，提交前由调用方校验，内核再校验一次）
 * @param props.hint 字段下方的说明
 * @param props.multiline 是否多行
 * @param props.dirty 是否显示“未保存”（保留参数以兼容旧调用）
 */
export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  dirty?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="ct-field">
      <label className="ct-field__label" htmlFor={id}>
        {props.label}
        {props.required && <span className="ct-field__req">（必填）</span>}
      </label>
      {props.multiline ? (
        <textarea
          id={id}
          className="ct-textarea"
          rows={props.rows ?? 2}
          value={props.value}
          placeholder={props.placeholder}
          autoFocus={props.autoFocus}
          onChange={(e) => props.onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="ct-input"
          value={props.value}
          placeholder={props.placeholder}
          autoFocus={props.autoFocus}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
      {props.hint && <div className="ct-field__hint">{props.hint}</div>}
    </div>
  );
}
