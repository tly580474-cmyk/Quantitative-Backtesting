import { describe, expect, it } from 'vitest';
import { parseCandles, toTencentCode } from './tencentProvider.js';

describe('Tencent market data provider', () => {
  it('maps Tencent OHLC rows using the live field order', () => {
    const candles = parseCandles({
      code: 0,
      data: {
        sh600519: {
          qfqday: [['2026-06-18', '1235.000', '1215.000', '1238.870', '1211.220', '57472.000']],
        },
      },
    }, 'sh600519', '600519', 'qfq');

    expect(candles).toEqual([{
      symbol: '600519',
      date: '2026-06-18',
      open: 1235,
      high: 1238.87,
      low: 1211.22,
      close: 1215,
      volume: 57472,
    }]);
  });

  it('normalizes common A-share symbol formats', () => {
    expect(toTencentCode('600519')).toBe('sh600519');
    expect(toTencentCode('000858')).toBe('sz000858');
    expect(toTencentCode('000001', 'SH')).toBe('sh000001');
    expect(toTencentCode('600519.SH')).toBe('sh600519');
  });
});

