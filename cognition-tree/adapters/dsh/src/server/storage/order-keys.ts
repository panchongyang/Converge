/** SQLite B-tree 键的编码。只产生排序键，展示用的 ID 与修订原时间仍逐行原样保存。 */

/**
 * 将稳定 ID 编成 SQLite BINARY 比较可 seek 的键，次序与内核的自然序契约一致。
 * @param id 节点、引用或修订的稳定 ID；不是文件名
 * @returns 非数字段按 UTF-16 字典序，数字段先比位数再比字典序，前缀在前
 */
export function idKey(id: string): Buffer {
  const parts = id.split(/(\d+)/);
  const key = Buffer.allocUnsafe(3 * id.length + 7 * parts.length);
  let offset = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index % 2 === 1) {
      offset = key.writeUInt32BE(part.length, offset);
      offset += key.write(part, offset, 'ascii');
    } else {
      // 保留全零给段尾，确保段前缀先排、空段也可比较。
      for (let i = 0; i < part.length; i += 1) offset = key.writeUIntBE(part.charCodeAt(i) + 1, offset, 3);
      offset = key.writeUIntBE(0, offset, 3);
    }
  }
  return key.subarray(0, offset);
}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const EPOCH_SHIFT_SECONDS = 8_640_000_000_000;

/**
 * 将时区偏移归一后编码时间键，保留任意精度的小数秒，不以本机时区参与排序。
 * @param at 修订原时间：带偏移的时刻、导入的日期/无时区时间，或无法解释的史料原文
 * @returns 可按字节比较的键；无时区/精度到日只为排序按 UTC，无法解析的原文最旧
 */
export function timeKey(at: string): Buffer {
  const match = ISO_TIME.exec(at);
  if (match !== null && match[0].length === at.length) {
    const [, y, m, d, h = '0', min = '0', sec = '0', fraction = '', zone = 'Z'] = match;
    const clock = new Date(0);
    clock.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
    const offsetHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
    const offsetMinutes = zone === 'Z' ? 0 : Number(zone.slice(-2));
    if (clock.getUTCFullYear() === Number(y) && clock.getUTCMonth() + 1 === Number(m)
      && clock.getUTCDate() === Number(d) && Number(h) <= 23 && Number(min) <= 59 && Number(sec) <= 59
      && offsetHours <= 23 && offsetMinutes <= 59) {
      const offset = (zone.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60;
      const epoch = clock.getTime() / 1000 + Number(h) * 3600 + Number(min) * 60 + Number(sec) - offset;
      // 前缀是定宽整数秒；去掉小数尾零后，字典序即小数值顺序，相同时由修订 ID 决定。
      return Buffer.from(`1${String(epoch + EPOCH_SHIFT_SECONDS).padStart(14, '0')}${fraction.replace(/0+$/, '')}`, 'ascii');
    }
  }
  // 未知原文采用 UTF-16BE，保持原文的 JS 字典顺序而不是数字自然序。
  return Buffer.concat([Buffer.from('0'), Buffer.from(at, 'utf16le').swap16()]);
}
