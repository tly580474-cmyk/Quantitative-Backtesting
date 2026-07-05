import { describe, expect, it } from 'vitest';
import { parseCandles, parseQuoteCandles, toTencentCode } from './tencentProvider.js';

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

  it('maps a bulk quote into a provisional/final daily candle', () => {
    const fields = Array.from({ length: 53 }, () => '');
    fields[3] = '11.68';
    fields[4] = '11.85';
    fields[5] = '11.56';
    fields[30] = '20260703150000';
    fields[33] = '11.70';
    fields[34] = '11.52';
    fields[36] = '1290000';
    fields[37] = '15002.817622';
    fields[38] = '0.66';

    expect(parseQuoteCandles(`v_sz000001="${fields.join('~')}";`)).toEqual([{
      symbol: '000001',
      date: '2026-07-03',
      open: 11.56,
      high: 11.7,
      low: 11.52,
      close: 11.68,
      previousClose: 11.85,
      volume: 129000000,
      turnover: 150028176.22,
      turnoverRatePct: 0.66,
    }]);
  });
});
