import { describe, expect, it } from 'vitest';
import {
  aggregateDailyKlines,
  mergeKlinePoints,
  shouldRefreshDailyKline,
} from './hybridKline.js';
import type { KlinePoint } from './aStockDataService.js';

function point(
  date: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): KlinePoint {
  return { date, open, high, low, close, volume };
}

describe('hybrid daily K-line data', () => {
  it('keeps the full database history and lets online rows replace the same date', () => {
    const database = [
      point('2026-07-20', 10, 11, 9, 10.5),
      point('2026-07-21', 10.5, 12, 10, 11),
    ];
    const online = [
      point('2026-07-21', 10.5, 12.5, 10, 12, 200),
      point('2026-07-22', 12, 13, 11.5, 12.8, 300),
    ];

    expect(mergeKlinePoints(database, online)).toEqual([
      database[0],
      online[0],
      online[1],
    ]);
  });

  it('refreshes during a trading session or whenever the database lacks today', () => {
    expect(shouldRefreshDailyKline('2026-07-22', '2026-07-22', true)).toBe(true);
    expect(shouldRefreshDailyKline('2026-07-21', '2026-07-22', false)).toBe(true);
    expect(shouldRefreshDailyKline('2026-07-22', '2026-07-22', false)).toBe(false);
  });

  it('aggregates database daily bars into complete weekly and yearly bars', () => {
    const daily = [
      point('2025-12-31', 8, 10, 7, 9, 50),
      point('2026-01-05', 10, 12, 9, 11, 100),
      point('2026-01-06', 11, 14, 10, 13, 150),
      point('2026-01-12', 13, 15, 12, 14, 200),
    ];

    expect(aggregateDailyKlines(daily, 'week')).toEqual([
      daily[0],
      point('2026-01-06', 10, 14, 9, 13, 250),
      daily[3],
    ]);
    expect(aggregateDailyKlines(daily, 'year')).toEqual([
      daily[0],
      point('2026-01-12', 10, 15, 9, 14, 450),
    ]);
  });
});
