import { describe, expect, it } from 'vitest';
import {
  amountYuanToYi,
  parseCsindexPerformanceRows,
  parseEastmoneyLatestIndexCandle,
  parseSinaUsIndexDailyCandles,
  parseTencentUsIndexDailyCandles,
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

describe('parseCsindexPerformanceRows', () => {
  it('maps official CSI 2000 history into the index candle contract', () => {
    expect(parseCsindexPerformanceRows([{
      tradeDate: '20260722',
      indexCode: '932000',
      open: 2798.53,
      high: 2843.75,
      low: 2766.96,
      close: 2786.28,
      change: -35.54,
      changePct: -1.26,
      tradingVol: 26_942_665_857,
      tradingValue: 3660.04,
      consNumber: 2000,
    }], '932000')).toEqual([{
      time: '2026-07-22',
      symbol: '932000',
      open: 2798.53,
      high: 2843.75,
      low: 2766.96,
      close: 2786.28,
      volume: 269_426_658.57,
      turnover: 3660.04,
      change: -35.54,
      changePercent: -1.26,
      constituentCount: 2000,
    }]);
  });

  it('drops malformed or mismatched official rows', () => {
    expect(parseCsindexPerformanceRows([{
      tradeDate: '20260722',
      indexCode: '000905',
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      tradingVol: 1,
      tradingValue: 1,
    }], '932000')).toEqual([]);
  });
});

describe('parseTencentUsIndexDailyCandles', () => {
  const payload = {
    data: {
      usNDX: {
        day: [
          // Tencent 列序：date, open, close, high, low, volume
          ['2026-09-08', '29645.18', '29507.70', '29655.73', '29400.70', '1315063152.00'],
          ['2026-09-09', '29431.94', '29421.55', '29563.60', '29334.41', '1158162386.00'],
          ['2026-09-11', '29331.48', '29368.44', '29473.12', '29313.51', '1109496376.00'],
        ],
      },
    },
  };

  it('maps Tencent rows into the NDX candle contract within the window', () => {
    expect(parseTencentUsIndexDailyCandles(payload, 'usNDX', 'NDX', '2026-09-09', '2026-09-11'))
      .toEqual([
        { time: '2026-09-09', symbol: 'NDX', open: 29431.94, high: 29563.60, low: 29334.41, close: 29421.55, volume: 1158162386 },
        { time: '2026-09-11', symbol: 'NDX', open: 29331.48, high: 29473.12, low: 29313.51, close: 29368.44, volume: 1109496376 },
      ]);
  });

  it('drops malformed rows and rows outside the window', () => {
    expect(parseTencentUsIndexDailyCandles(
      { data: { usNDX: { day: [['2026-09-10', '1', '2'], ['bad', '1', '2', '3', '4', '5'], ['2026-08-01', '1', '2', '3', '4', '5']] } } },
      'usNDX', 'NDX', '2026-09-09', '2026-09-11',
    )).toEqual([]);
  });

  it('returns an empty list when the upstream payload is missing', () => {
    expect(parseTencentUsIndexDailyCandles({}, 'usNDX', 'NDX', '2026-09-01', '2026-09-11')).toEqual([]);
  });
});

describe('parseSinaUsIndexDailyCandles', () => {
  it('parses the Sina JSONP payload and filters by date window', () => {
    const payload = 'var_data=(['
      + '{"d":"2026-09-08","o":"29645.18","h":"29655.73","l":"29400.70","c":"29507.70","v":"1224093226","a":"0"},'
      + '{"d":"2026-09-11","o":"29331.48","h":"29473.12","l":"29313.51","c":"29368.44","v":"1082419792","a":"0"}'
      + ']);';
    expect(parseSinaUsIndexDailyCandles(payload, 'NDX', '2026-09-09', '2026-09-11')).toEqual([
      { time: '2026-09-11', symbol: 'NDX', open: 29331.48, high: 29473.12, low: 29313.51, close: 29368.44, volume: 1082419792 },
    ]);
  });

  it('returns an empty list for a non-JSONP response', () => {
    expect(parseSinaUsIndexDailyCandles('<html>blocked</html>', 'NDX', '2026-09-01', '2026-09-11')).toEqual([]);
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
