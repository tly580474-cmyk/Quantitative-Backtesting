import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMarketIndexQuotes,
  fetchStockQuote,
  parseEastmoneyDailyKlines,
} from './aStockDataService.js';

describe('A-share stock quote service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps Tencent quote market-cap fields using the live field order', async () => {
    const fields = Array.from({ length: 55 }, () => '');
    fields[1] = 'LONGI';
    fields[3] = '580';
    fields[44] = '2356.76';
    fields[45] = '4801.85';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `v_sh601869="${fields.join('~')}";`,
      { status: 200 },
    )));

    const quote = await fetchStockQuote('601869', false);

    expect(quote.marketCapYi).toBe(4801.85);
    expect(quote.floatMarketCapYi).toBe(2356.76);
  });

  it('loads market index quotes from explicit Tencent market-prefixed codes', async () => {
    const sh = Array.from({ length: 55 }, () => '');
    sh[1] = '上证指数';
    sh[3] = '4109.27';
    sh[32] = '-0.04';
    sh[44] = '636066.36';
    sh[45] = '688534.84';

    const sz = Array.from({ length: 55 }, () => '');
    sz[1] = '深证成指';
    sz[3] = '16109.81';
    sz[32] = '0.36';

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('sh000001');
      expect(String(url)).toContain('sz399001');
      return new Response(
        `v_sh000001="${sh.join('~')}";\nv_sz399001="${sz.join('~')}";`,
        { status: 200 },
      );
    }));

    const quotes = await fetchMarketIndexQuotes();

    expect(quotes[0]).toMatchObject({
      code: '000001',
      name: '上证指数',
      market: 'SH',
      type: 'index',
      price: 4109.27,
      changePct: -0.04,
      marketCapYi: 688534.84,
      floatMarketCapYi: 636066.36,
    });
    expect(quotes[1]).toMatchObject({
      code: '399001',
      name: '深证成指',
      market: 'SZ',
      type: 'index',
      price: 16109.81,
      changePct: 0.36,
    });
  });

  it('respects explicit market prefixes when loading a quote', async () => {
    const fields = Array.from({ length: 55 }, () => '');
    fields[1] = 'SHINDEX';
    fields[3] = '4109.27';

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('q=sh000001');
      return new Response(`v_sh000001="${fields.join('~')}";`, { status: 200 });
    }));

    const quote = await fetchStockQuote('sh000001', false);

    expect(quote).toMatchObject({
      code: '000001',
      name: 'SHINDEX',
      market: 'SH',
      type: 'index',
      price: 4109.27,
    });
  });

  it('maps Eastmoney daily f61 to the real turnover-rate field', () => {
    const points = parseEastmoneyDailyKlines([
      '2026-07-02,1193.01,1203.00,1215.52,1190.51,50870,6122360932.00,2.10,0.84,9.99,0.41',
    ]);

    expect(points).toEqual([{
      date: '2026-07-02',
      open: 1193.01,
      close: 1203,
      high: 1215.52,
      low: 1190.51,
      volume: 50870,
      turnoverRatePct: 0.41,
    }]);
  });

  it('does not invent a turnover rate when Eastmoney returns a placeholder', () => {
    const points = parseEastmoneyDailyKlines([
      '2026-07-02,4100,4110,4120,4090,100000,1000000000,0.73,0.20,8.20,-',
    ]);

    expect(points[0].turnoverRatePct).toBeUndefined();
  });
});
