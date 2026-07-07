import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseCandles,
  parseQuoteCandles,
  TencentMarketDataProvider,
  toTencentCode,
} from './tencentProvider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Tencent market data provider', () => {
  it('maps Tencent OHLC rows using the live field order', () => {
    const candles = parseCandles({
      code: 0,
      data: {
        sh600519: {
          qfqday: [['2026-06-18', '1235.000', '1215.000', '1238.870', '1211.220', '57472.000']],
          qt: {
            sh600519: Array.from({ length: 53 }, (_, index) => ({
              4: '1220.00',
              30: '20260618150000',
              37: '70000.50',
              38: '0.31',
            }[index] ?? '')),
          },
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
      previousClose: 1220,
      volume: 5747200,
      turnover: 700005000,
      turnoverRatePct: 0.31,
    }]);
  });

  it('does not multiply index kline volume because Tencent already returns index volume in shares', () => {
    const candles = parseCandles({
      code: 0,
      data: {
        sh000852: {
          day: [['2026-07-07', '8436.390', '8301.800', '8489.480', '8261.400', '244575082.000']],
        },
      },
    }, 'sh000852', '000852', 'none');

    expect(candles).toEqual([{
      symbol: '000852',
      date: '2026-07-07',
      open: 8436.39,
      high: 8489.48,
      low: 8261.4,
      close: 8301.8,
      volume: 244575082,
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
    fields[39] = '6.87';
    fields[44] = '1800.50';
    fields[45] = '2100.75';
    fields[46] = '0.72';
    fields[47] = '13.04';
    fields[49] = '1.35';

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
      totalMarketCap: 210075000000,
      floatMarketCap: 180050000000,
      peTtm: 6.87,
      pb: 0.72,
      volumeRatio: 1.35,
      limitUp: 13.04,
    }]);
  });

  it('does not multiply index quote volume', () => {
    const fields = Array.from({ length: 53 }, () => '');
    fields[3] = '8301.80';
    fields[4] = '8472.60';
    fields[5] = '8436.39';
    fields[30] = '20260707161401';
    fields[33] = '8489.48';
    fields[34] = '8261.40';
    fields[36] = '244575082';
    fields[37] = '54445625';

    expect(parseQuoteCandles(`v_sh000852="${fields.join('~')}";`)).toMatchObject([{
      symbol: '000852',
      date: '2026-07-07',
      volume: 244575082,
      turnover: 544456250000,
    }]);
  });

  it('keeps successful quote chunks when another chunk fails', async () => {
    const fields = Array.from({ length: 53 }, () => '');
    fields[3] = '11.68';
    fields[4] = '11.85';
    fields[5] = '11.56';
    fields[30] = '20260706150000';
    fields[33] = '11.70';
    fields[34] = '11.52';
    fields[36] = '1290000';
    fields[37] = '15002.817622';
    fields[38] = '0.66';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('sh600070')) return new Response('', { status: 500 });
      return new Response(`v_sh600000="${fields.join('~')}";`, { status: 200 });
    }));
    const provider = new TencentMarketDataProvider();
    const instruments = Array.from({ length: 71 }, (_, index) => ({
      symbol: String(600000 + index),
      market: 'SH',
    }));

    await expect(provider.fetchCurrentDailyCandles({ instruments }))
      .resolves.toMatchObject([{ symbol: '600000', turnover: 150028176.22 }]);
  });

  it('reports an error when every quote chunk fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const provider = new TencentMarketDataProvider();
    await expect(provider.fetchCurrentDailyCandles({
      instruments: [{ symbol: '600000', market: 'SH' }],
    })).rejects.toThrow('腾讯批量行情请求失败');
  });
});
