/**
 * 浏览器时钟：交给正式内核的 Clock 端口。
 *
 * 新修订取一次含本地时区偏移的 ISO 时刻；导入历史不调用它，保留手稿精度。
 */
import type { Clock } from '@cognition-tree/kernel/types';

/**
 * 系统时钟。
 * @returns 每次调用都取当前时刻，格式如 "2026-11-20T20:41:51.123+08:00"
 */
export function createSystemClock(): Clock {
  return {
    now() {
      const d = new Date();
      const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
      const off = -d.getTimezoneOffset();
      return (
        d.getFullYear() +
        '-' + pad(d.getMonth() + 1) +
        '-' + pad(d.getDate()) +
        'T' + pad(d.getHours()) +
        ':' + pad(d.getMinutes()) +
        ':' + pad(d.getSeconds()) +
        '.' + pad(d.getMilliseconds(), 3) +
        (off >= 0 ? '+' : '-') +
        pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60)
      );
    },
  };
}

/** 页面共用的系统时钟实例。 */
export const systemClock: Clock = createSystemClock();
