import { describe, expect, it } from 'vitest';
import { assertNever, compareIds, isNonBlank, utf8ByteLength } from '../src/utils';

describe('compareIds', () => {
  it('数字位数不同时按数值排序', () => {
    expect(compareIds('T1.2.9', 'T1.2.10')).toBeLessThan(0);
    expect(compareIds('T1.2.10', 'T1.2.9')).toBeGreaterThan(0);
    expect(compareIds('T1.2.9', 'T1.2.9')).toBe(0);
  });

  it('分段不同时长的排在短的之后，且逐段比较', () => {
    expect(compareIds('T1.2', 'T1.2.1')).toBeLessThan(0);
    expect(compareIds('T1.2.1', 'T1.2')).toBeGreaterThan(0);
    expect(compareIds('T1.2.1', 'T1.3')).toBeLessThan(0);
    expect(compareIds('T1.10', 'T1.9')).toBeGreaterThan(0);
  });

  it('非数字段按字典序比较，并可稳定排序', () => {
    const ids = ['T1.2.10', 'T1.2.2', 'T1.2.1', 'T1.10', 'T1.2'];
    expect([...ids].sort(compareIds)).toEqual(['T1.2', 'T1.2.1', 'T1.2.2', 'T1.2.10', 'T1.10']);
  });
});

describe('isNonBlank', () => {
  it('接受至少含一个非空白字符的字符串', () => {
    expect(isNonBlank('剪除')).toBe(true);
    expect(isNonBlank('  有理由  ')).toBe(true);
  });

  it('拒绝空白字符串和非字符串', () => {
    expect(isNonBlank('')).toBe(false);
    expect(isNonBlank('  \t\n')).toBe(false);
    expect(isNonBlank(42)).toBe(false);
    expect(isNonBlank(null)).toBe(false);
  });
});

describe('utf8ByteLength', () => {
  it('ASCII 按 1 字节计', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('')).toBe(0);
  });

  it('中文按 UTF-8 字节计，而不是字符数', () => {
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('判')).toBe(3);
  });

  it('混合文本与补充平面字符按各自编码长度计', () => {
    expect(utf8ByteLength('a中')).toBe(4);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('🌳')).toBe(4);
  });
});

describe('assertNever', () => {
  it('命中未处理分支时抛错', () => {
    expect(() => assertNever('意外种类' as never)).toThrowError('未处理的分支：意外种类');
  });
});
