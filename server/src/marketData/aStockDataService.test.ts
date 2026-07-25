import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMarketIndexQuotes,
  fetchStockKline,
  fetchStockQuote,
  inferType,
  normalizeOnlineVolumeToShares,
  normalizeSinaTurnoverRatePct,
  parseEastmoneyDailyKlines,
  parseSinaUsIndexDailyKline,
  resolveSecurity,
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
      if (!String(url).includes('qt.gtimg.cn')) {
        return new Response(JSON.stringify({ data: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
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

  it.each([
    ['ft932000', { code: '932000', market: 'SH', prefixed: '', eastmoneySecid: '2.932000' }],
    ['sh932000', { code: '932000', market: 'SH', prefixed: '', eastmoneySecid: '2.932000' }],
    ['usSPX', { code: 'SPX', market: 'US', prefixed: 'usINX', sinaSymbol: '.INX' }],
    ['usDJIA', { code: 'DJIA', market: 'US', prefixed: 'usDJI', sinaSymbol: '.DJI' }],
    ['jpN225', { code: 'N225', market: 'JP', prefixed: '', eastmoneySecid: '100.N225' }],
    ['krKS11', { code: 'KS11', market: 'KR', prefixed: '', eastmoneySecid: '100.KS11' }],
  ])('normalizes index alias %s to its canonical security', (alias, expected) => {
    expect(resolveSecurity(alias)).toMatchObject(expected);
  });

  it('classifies CSI 2000 as an index rather than a stock', () => {
    expect(inferType('932000', 'SH')).toBe('index');
  });

  it('uses Sina daily history when Tencent only exposes one US-index point', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('US_MinKService.getDailyK');
      return new Response(
        '/*guard*/var_data=([{"d":"2026-07-22","o":"100","h":"103","l":"99","c":"102","v":"10"},'
        + '{"d":"2026-07-23","o":"102","h":"104","l":"101","c":"103","v":"11"},'
        + '{"d":"2026-07-24","o":"103","h":"105","l":"102","c":"104","v":"12"}]);',
        { status: 200 },
      );
    }));

    const points = await fetchStockKline('usINX', 'day', 2);

    expect(points).toHaveLength(2);
    expect(points.map((point) => point.date)).toEqual(['2026-07-23', '2026-07-24']);
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

  it('parses Sina US-index JSONP rows', () => {
    const points = parseSinaUsIndexDailyKline(
      'var_data=([{"d":"2026-07-24","o":"10","h":"10.5","l":"10.2","c":"11","v":"25","a":"300"}]);',
    );

    expect(points).toEqual([{
      date: '2026-07-24',
      open: 10,
      close: 11,
      high: 11,
      low: 10,
      volume: 25,
      amount: 300,
    }]);
  });

  it('normalizes mainland stock and ETF online volume from lots to shares', () => {
    expect(normalizeOnlineVolumeToShares(5_492.3, '002298', 'SZ')).toBe(549_230);
    expect(normalizeOnlineVolumeToShares(12_345, '510300', 'SH')).toBe(1_234_500);
    expect(normalizeOnlineVolumeToShares(12_345, '000001', 'SH')).toBe(12_345);

    const points = parseEastmoneyDailyKlines([
      '2026-07-24,7.73,8.10,8.10,7.67,5492.3,4440000,10.05,0.74,0,8.31',
    ], 100);
    expect(points[0].volume).toBe(549_230);
  });

  it('does not invent a turnover rate when Eastmoney returns a placeholder', () => {
    const points = parseEastmoneyDailyKlines([
      '2026-07-02,4100,4110,4120,4090,100000,1000000000,0.73,0.20,8.20,-',
    ]);

    expect(points[0].turnoverRatePct).toBeUndefined();
  });

  it('converts Sina turnover ratios to percentage points', () => {
    expect(normalizeSinaTurnoverRatePct(0.09)).toBeCloseTo(9, 10);
    expect(normalizeSinaTurnoverRatePct('0.0041')).toBeCloseTo(0.41, 10);
    expect(normalizeSinaTurnoverRatePct(null)).toBeNull();
    expect(normalizeSinaTurnoverRatePct(-0.1)).toBeNull();
  });
});
