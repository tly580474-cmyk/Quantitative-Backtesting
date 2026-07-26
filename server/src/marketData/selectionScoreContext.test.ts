import { describe, expect, it } from 'vitest';
import { extractSelectionScoreContext } from './selectionScoreContext.js';
import type { StockQuote } from './aStockDataService.js';

const quote: StockQuote = {
  code: '000001',
  name: '测试银行',
  market: 'SZ',
  type: 'stock',
  price: 10,
  changeAmount: 0,
  changePct: 0,
  open: 10,
  high: 10,
  low: 10,
  previousClose: 10,
  limitUp: 11,
  limitDown: 9,
  turnoverPct: 1,
  amplitudePct: 1,
  volumeRatio: 1,
  amountWan: 1000,
  peTtm: 8,
  peStatic: 9,
  pb: 0.9,
  marketCapYi: 1200,
  floatMarketCapYi: 1000,
  listDate: '1991-01-01',
  industry: '银行',
  updatedAt: '2026-07-25T00:00:00.000Z',
  source: ['腾讯'],
};

describe('selection score context', () => {
  it('merges quote, financial quality and local trailing dividend metrics', () => {
    const result = extractSelectionScoreContext(
      quote,
      {
        records: [{
          source: '核心财务',
          date: '2026-03-31',
          metrics: { roe: '12.5%', revenueGrowth: 18, netProfitGrowth: 22, debtRatio: 45, ps: 2.1 },
        }],
      },
      {
        records: [{
          source: '本地研究快照（分红事件）',
          date: '2026-07-25',
          metrics: { dividendYield: 3.8 },
        }],
      },
    );

    expect(result).toMatchObject({
      peTtm: 8,
      pb: 0.9,
      psTtm: 2.1,
      marketCapYi: 1200,
      dividendYieldPct: 3.8,
      roePct: 12.5,
      revenueGrowthPct: 18,
      netProfitGrowthPct: 22,
      asOf: '2026-07-25',
    });
    expect(result.sources).toEqual(['腾讯', '核心财务', '本地研究快照（分红事件）']);
  });

  it('keeps unavailable fields explicit instead of inventing zeroes', () => {
    const result = extractSelectionScoreContext(
      { ...quote, peTtm: null, pb: null, marketCapYi: null, floatMarketCapYi: null },
      { records: [] },
      { records: [] },
    );
    expect(result.peTtm).toBeNull();
    expect(result.dividendYieldPct).toBeNull();
    expect(result.roePct).toBeNull();
    expect(result.sources).toEqual(['腾讯']);
  });
});
