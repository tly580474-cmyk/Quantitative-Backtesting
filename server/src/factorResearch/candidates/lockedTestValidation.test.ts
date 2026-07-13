import { describe, expect, it } from 'vitest';
import {
  assertLockedTestCoverage,
  assertLockedTestLineage,
  hasMinimumLockedTestCalendarSpan,
} from './lockedTestValidation.js';

describe('locked test validation', () => {
  it('rejects the one-day scheduled window before starting a test', () => {
    expect(() => assertLockedTestLineage({
      splits: { test: { start: '2026-07-13', end: '2026-07-13', rows: 47 } },
    }, { startDate: '2026-07-13', endDate: '2026-07-13' })).toThrow('样本仅 47 行');
  });

  it('requires the request to use the frozen lineage interval', () => {
    expect(() => assertLockedTestLineage({
      splits: { test: { start: '2024-01-02', end: '2026-07-10', rows: 100_000 } },
    }, { startDate: '2026-01-01', endDate: '2026-07-10' })).toThrow('冻结血缘一致');
  });

  it('rejects an empty report instead of allowing tested status', () => {
    expect(() => assertLockedTestCoverage({ sampleCount: 0, tradingDays: 0 }))
      .toThrow('实际样本数不足 1000');
  });

  it('accepts sufficient lineage and report coverage', () => {
    expect(() => assertLockedTestLineage({
      splits: { test: { start: '2024-01-02', end: '2026-07-10', rows: 100_000 } },
    }, { startDate: '2024-01-02', endDate: '2026-07-10' })).not.toThrow();
    expect(() => assertLockedTestCoverage({ sampleCount: 50_000, tradingDays: 120 })).not.toThrow();
  });

  it('waits for a plausible trading-day window before scheduled mining', () => {
    expect(hasMinimumLockedTestCalendarSpan('2026-07-10', '2026-07-13')).toBe(false);
    expect(hasMinimumLockedTestCalendarSpan('2026-07-10', '2026-09-08')).toBe(true);
  });
});
