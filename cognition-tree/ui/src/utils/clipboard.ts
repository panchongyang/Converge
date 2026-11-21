/**
 * 剪贴板：把一段文字写进系统剪贴板。
 *
 * 优先用异步剪贴板接口；非安全上下文（例如用局域网 IP 打开 DSH 面板）或权限被拒时，
 * 退回临时 textarea + execCommand，保证「复制 ID」在两种宿主里都可用。
 * 只写文本，不读剪贴板。
 */

/**
 * 把文本写进剪贴板。
 * @param text 要复制的文本
 * @returns 是否写入成功；调用方据此显示「已复制」或「复制失败」
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走退路：非安全上下文或被拒绝时异步接口不可用。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
