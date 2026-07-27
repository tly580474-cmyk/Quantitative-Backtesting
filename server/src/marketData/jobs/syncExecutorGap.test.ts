import { describe, expect, it } from 'vitest';
import { resolveIncrementalGapRange } from './syncExecutor.js';

describe('resolveIncrementalGapRange', () => {
  it('does not backfill dates before a newly listed stock existed', () => {
    expect(resolveIncrementalGapRange({
      priorTradeDate: null,
      listDate: '2026-07-27',
      priorOpenDate: '2026-07-24',
    })).toBeNull();
  });

  it('backfills from the day after the latest stored bar', () => {
    expect(resolveIncrementalGapRange({
      priorTradeDate: '2026-07-22',
      listDate: '2020-01-01',
      priorOpenDate: '2026-07-24',
    })).toEqual({
      startDate: '2026-07-23',
      endDate: '2026-07-24',
    });
  });

  it('backfills from listing date when no prior bar exists', () => {
    expect(resolveIncrementalGapRange({
      priorTradeDate: null,
      listDate: '2026-07-23',
      priorOpenDate: '2026-07-24',
    })).toEqual({
      startDate: '2026-07-23',
      endDate: '2026-07-24',
    });
  });
});
