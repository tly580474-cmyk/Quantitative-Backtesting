import { describe, it, expect } from 'vitest';
import { parseDate, isWeekend, formatDateStr } from '../date';

describe('parseDate', () => {
  it('parses YYYYMMDD number string', () => {
    expect(parseDate('20210619')).toBe('2021-06-19');
  });

  it('parses YYYYMMDD as number', () => {
    expect(parseDate(20210619)).toBe('2021-06-19');
  });

  it('parses ISO date string', () => {
    expect(parseDate('2021-06-19')).toBe('2021-06-19');
  });

  it('parses date with slashes', () => {
    expect(parseDate('2021/06/19')).toBe('2021-06-19');
  });

  it('returns null for null input', () => {
    expect(parseDate(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseDate(undefined)).toBeNull();
  });

  it('returns null for invalid date', () => {
    expect(parseDate('not a date')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseDate('')).toBeNull();
  });
});

describe('isWeekend', () => {
  it('detects Saturday', () => {
    expect(isWeekend('2021-06-19')).toBe(true);
  });

  it('detects Sunday', () => {
    expect(isWeekend('2021-06-20')).toBe(true);
  });

  it('detects weekday', () => {
    expect(isWeekend('2021-06-21')).toBe(false);
  });

  it('returns false for invalid date', () => {
    expect(isWeekend('invalid')).toBe(false);
  });
});

describe('formatDateStr', () => {
  it('formats date to YYYY-MM-DD', () => {
    expect(formatDateStr(new Date(2021, 5, 19))).toBe('2021-06-19');
  });
});
