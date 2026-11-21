/**
 * 内存存储的索引键与时间排序。
 *
 * 职责：定义子节点、引用端点、时间线、节点历史与未确认索引的键形状和比较函数；
 * 把修订的 `at` 解析成含时区偏移、可按键 seek 的排序键，日期精度与无时区时间不丢。
 * 边界：只做键编码与比较，不读树、不判业务；解析失败的时间按原文本排在最旧，不伪造时刻。
 * 协作：indexes / unconfirmed 建索引，snapshot 用同一比较函数生成游标键，保证分页不漏不重。
 */
import type { RevisionId } from '../../types';
import { compareIds } from '../../utils';

/** 子节点索引键：[父节点 ID, 子节点 ID]；按父节点聚在一起，组内按稳定 ID 排序。 */
export type ChildKey = readonly [parentId: string, childId: string];

/** 引用端点索引键：[起点或树内目标节点 ID, 引用 ID]；同一节点的边按引用 ID 排序。 */
export type RefKey = readonly [nodeId: string, refId: string];

/** 时间线索引键：[时间排序键, 修订 ID]；同一时刻按修订 ID 稳定排序。 */
export type TimeKey = readonly [timeSort: string, revisionId: RevisionId];

/** 节点历史索引键：[节点 ID, 时间排序键, 修订 ID]。 */
export type NodeRevisionKey = readonly [
  nodeId: string,
  timeSort: string,
  revisionId: RevisionId,
];

/** 导入判断未确认索引键：[节点 ID]。 */
export type ImportKey = readonly [nodeId: string];

/** 节点历史无上界时的键分量；比任何实际时间排序键与修订 ID 都大。 */
export const MAX_KEY_PART = '\uffff';

/** 时间排序键的纪元偏移，让 1970 年前的毫秒数也落在固定宽度的非负区间。 */
const EPOCH_OFFSET = 8_640_000_000_000_000;

/** 含日期与可选时刻、时区偏移的 ISO 时间。 */
const FULL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** 只有日期的导入时间，例如 "2026-11-19"。 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 解析结果：排序用的 epoch 毫秒（秒精度）与补足九位的小数秒。 */
interface ParsedTime {
  epochMs: number;
  fraction: string;
}

/**
 * 解析日期各段并进行范围校验，避免 Date 自动进位把非法日期排到别处。
 * @param month 月，1–12
 * @param day 日，1–31
 * @param hour 时，0–23
 * @param minute 分，0–59
 * @param second 秒，0–59
 * @returns 各段都在范围内时为 true
 */
function checkParts(
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  return true;
}

/**
 * 把 `at` 解析成排序用的秒级 epoch 与九位小数；无时区按 UTC 排，日期只有精度到日。
 * @param at 修订的实际发生时间，可能来自新写入或导入历史
 * @returns 解析结果；无法识别时为 null
 */
function parseTime(at: string): ParsedTime | null {
  const dateOnly = DATE_ONLY.exec(at);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!checkParts(month, day, 0, 0, 0)) return null;
    const epochMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    return { epochMs, fraction: '000000000' };
  }

  const full = FULL_TIME.exec(at);
  if (full === null) return null;
  const year = Number(full[1]);
  const month = Number(full[2]);
  const day = Number(full[3]);
  const hour = Number(full[4]);
  const minute = Number(full[5]);
  const second = full[6] === undefined ? 0 : Number(full[6]);
  if (!checkParts(month, day, hour, minute, second)) return null;

  // 先按“墙上时间”取秒级 UTC，再减去时区偏移；Z 与缺省都按 0 处理。
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let offsetMinutes = 0;
  const zone = full[8];
  if (zone !== undefined && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const rawFraction = full[7] ?? '';
  return {
    epochMs: wallMs - offsetMinutes * 60_000,
    fraction: rawFraction.padEnd(9, '0').slice(0, 9),
  };
}

/**
 * 把修订时间编码成定宽、可字符串比较的排序键。
 * 同一实际时刻的不同时区写法得到相同键，再由修订 ID 稳定排序；
 * 只有日期时按当日 0 点参与排序（排序用，不回填展示时间）；无法解析时排在最旧并按原文比较。
 * @param at 修订的实际发生时间
 * @returns 排序键字符串
 */
export function timeSortKey(at: string): string {
  const parsed = parseTime(at);
  if (parsed === null) return '0' + at;
  const shifted = parsed.epochMs + EPOCH_OFFSET;
  return '1' + String(shifted).padStart(17, '0') + parsed.fraction;
}

/**
 * 构造一条修订的时间线键。
 * @param at 修订的实际发生时间
 * @param revisionId 修订 ID
 * @returns 可直接用于时间索引的键
 */
export function revisionTimeKey(at: string, revisionId: RevisionId): TimeKey {
  return [timeSortKey(at), revisionId];
}

/**
 * 按码点比较两个字符串；时间排序键与哨兵值用它，不走 ID 的数字自然序。
 * @param left 左侧字符串
 * @param right 右侧字符串
 * @returns 负数、零或正数
 */
export function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 比较子节点索引键。
 * @param left 左侧键
 * @param right 右侧键
 * @returns 先按父节点 ID 自然序，再按子节点 ID 自然序
 */
export function compareChildKeys(left: ChildKey, right: ChildKey): number {
  return compareIds(left[0], right[0]) || compareIds(left[1], right[1]);
}

/**
 * 比较引用端点索引键。
 * @param left 左侧键
 * @param right 右侧键
 * @returns 先按节点 ID 自然序，再按引用 ID 自然序
 */
export function compareRefKeys(left: RefKey, right: RefKey): number {
  return compareIds(left[0], right[0]) || compareIds(left[1], right[1]);
}

/**
 * 比较时间线索引键。
 * @param left 左侧键
 * @param right 右侧键
 * @returns 先按时间排序键，再按修订 ID 自然序
 */
export function compareTimeKeys(left: TimeKey, right: TimeKey): number {
  return compareText(left[0], right[0]) || compareIds(left[1], right[1]);
}

/**
 * 比较节点历史索引键。
 * @param left 左侧键
 * @param right 右侧键
 * @returns 先按节点 ID，再按时间，最后按修订 ID
 */
export function compareNodeRevisionKeys(
  left: NodeRevisionKey,
  right: NodeRevisionKey,
): number {
  return (
    compareIds(left[0], right[0]) ||
    compareText(left[1], right[1]) ||
    compareIds(left[2], right[2])
  );
}

/**
 * 比较导入判断索引键。
 * @param left 左侧键
 * @param right 右侧键
 * @returns 按节点 ID 自然序
 */
export function compareImportKeys(left: ImportKey, right: ImportKey): number {
  return compareIds(left[0], right[0]);
}
