import { describe, expect, it } from 'vitest';
import {
  buildMinuteQuery,
  normalizeMinuteSymbol,
  parseMinuteInterval,
} from './duckdbMinuteQuery.js';

describe('duckdb minute aggregation query', () => {
  it('normalizes A-share symbols', () => {
    expect(normalizeMinuteSymbol('688656')).toBe('688656.SH');
    expect(normalizeMinuteSymbol('601899')).toBe('601899.SH');
    expect(normalizeMinuteSymbol('002155')).toBe('002155.SZ');
    expect(normalizeMinuteSymbol('830799')).toBe('830799.BJ');
  });

  it('builds monthly parquet pruning and session-aligned 5m SQL', () => {
    const result = buildMinuteQuery({
      minuteRoot: 'D:/minute',
      symbols: ['688656', '601899'],
      startDate: '2026-06-16',
      endDate: '2026-07-16',
      interval: '5m',
      includeAuction: false,
    });
    expect(result.symbols).toEqual(['688656.SH', '601899.SH']);
    expect(result.parquetPatterns).toHaveLength(2);
    expect(result.sql).toContain('202606*.parquet');
    expect(result.sql).toContain('202607*.parquet');
    expect(result.sql).toContain('FLOOR(minuteIndex / 5)');
    expect(result.sql).toContain("STRFTIME('%H:%M', CAST(trade_time AS TIMESTAMP)) <> '09:30'");
    expect(result.sql).toContain('DECIMAL(18, 6)');
    expect(result.sql).toContain('DECIMAL(24, 2)');
    expect(result.params.code0).toBe('688656.SH');
  });

  it('defaults to the last 30 natural days', () => {
    const result = buildMinuteQuery({
      minuteRoot: 'D:/minute',
      symbols: ['688656'],
      days: '30',
      interval: '5',
      includeAuction: false,
    }, new Date('2026-07-16T12:00:00'));
    expect(result.startDate).toBe('2026-06-17');
    expect(result.endDate).toBe('2026-07-16');
  });

  it('validates interval and symbols', () => {
    expect(parseMinuteInterval('15m')).toBe(15);
    expect(() => parseMinuteInterval('7m')).toThrow('仅支持');
    expect(() => normalizeMinuteSymbol('ABC')).toThrow('股票代码无效');
  });
});
