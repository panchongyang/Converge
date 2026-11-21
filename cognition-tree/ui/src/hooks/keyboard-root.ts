/** 阅读界面的键盘边界取自实际挂载点，不依赖宿主名称；独立网页为 document，嵌入面板可为 ShadowRoot。 */

/**
 * 只在挂载点自己的事件根监听按键，避免嵌入时拦截宿主输入框或另一份认知树的事件。
 * @param anchor 已挂载的界面元素；尚未挂载不注册监听
 * @param handler 本界面对按键的响应
 * @param capture 书写区在冒泡快捷键之前处理提交/收回
 * @returns 卸载时取消这一次绑定的函数
 */
export function listenForKeys(anchor: Element | null, handler: (event: KeyboardEvent) => void, capture = false): () => void {
  const root = anchor?.getRootNode();
  const listener: EventListener = event => handler(event as KeyboardEvent);
  root?.addEventListener('keydown', listener, capture);
  return () => root?.removeEventListener('keydown', listener, capture);
}
