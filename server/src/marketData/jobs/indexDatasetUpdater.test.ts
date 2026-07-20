import { describe, expect, it } from 'vitest';
import {
  amountYuanToYi,
  parseEastmoneyLatestIndexCandle,
  resolveIndexTargetDate,
} from './indexDatasetUpdater.js';

describe('amountYuanToYi', () => {
  it('converts provider amounts from yuan to the Candle 亿元 unit', () => {
    expect(amountYuanToYi(686_333_877_873.84)).toBeCloseTo(6_863.3387787384, 10);
    expect(amountYuanToYi(undefined)).toBeUndefined();
  });
});

describe('parseEastmoneyLatestIndexCandle', () => {
  it('maps the authoritative close snapshot without mixing Tencent units', () => {
    expect(parseEastmoneyLatestIndexCandle({
      f43: 342863,
      f44: 364206,
      f45: 338726,
      f46: 364206,
      f47: 237152349,
      f48: 686333877873.84,
      f57: '399006',
      f60: 369246,
      f168: 424,
      f169: -26383,
      f170: -715,
    }, '2026-07-17', '399006')).toEqual(expect.objectContaining({
      close: 3428.63,
      change: -263.83,
      changePercent: -7.15,
      volume: 237152349,
      turnover: 6863.3387787384,
      turnoverRatePct: 4.24,
    }));
  });
});

describe('resolveIndexTargetDate', () => {
  it('uses the previous business day while the China market is open', () => {
    expect(resolveIndexTargetDate('cn-index', new Date('2026-07-02T06:30:00Z')))
      .toBe('2026-07-01');
  });

  it('allows the current China business day once the market has closed', () => {
    expect(resolveIndexTargetDate('cn-index', new Date('2026-07-02T07:00:00Z')))
      .toBe('2026-07-02');
  });

  it('rolls a Monday China intraday update back to Friday', () => {
    expect(resolveIndexTargetDate('cn-index', new Date('2026-07-06T06:30:00Z')))
      .toBe('2026-07-03');
  });

  it('uses the previous business day while Nasdaq is open', () => {
    expect(resolveIndexTargetDate('us-index', new Date('2026-07-02T19:59:00Z')))
      .toBe('2026-07-01');
  });

  it('allows the current New York business day once Nasdaq has closed', () => {
    expect(resolveIndexTargetDate('us-index', new Date('2026-07-02T20:00:00Z')))
      .toBe('2026-07-02');
  });

  it('handles the New York winter UTC offset', () => {
    expect(resolveIndexTargetDate('us-index', new Date('2026-01-02T21:00:00Z')))
      .toBe('2026-01-02');
  });

  it('rolls weekend updates back to Friday', () => {
    expect(resolveIndexTargetDate('cn-index', new Date('2026-07-05T08:00:00Z')))
      .toBe('2026-07-03');
    expect(resolveIndexTargetDate('us-index', new Date('2026-07-05T20:00:00Z')))
      .toBe('2026-07-03');
  });
});
