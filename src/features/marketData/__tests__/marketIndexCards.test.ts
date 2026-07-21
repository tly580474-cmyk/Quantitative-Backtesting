import { describe, expect, it } from 'vitest';
import { buildMarketIndexCards, resolveMarketIndexSnapshot, type MarketIndexOption } from '../marketIndexCards';
import type { KlinePoint, StockQuote } from '../types';

const options: MarketIndexOption[] = [
  { key: 'SH:000001', code: '000001', name: '上证指数', market: 'SH', prefixed: 'sh000001' },
  { key: 'SZ:399001', code: '399001', name: '深证成指', market: 'SZ', prefixed: 'sz399001' },
  { key: 'SZ:399006', code: '399006', name: '创业板指', market: 'SZ', prefixed: 'sz399006' },
  { key: 'SH:000852', code: '000852', name: '中证1000', market: 'SH', prefixed: 'sh000852' },
  { key: 'SH:932000', code: '932000', name: '中证2000', market: 'SH', prefixed: 'ft932000' },
];

function quote(option: MarketIndexOption): StockQuote {
  return {
    code: option.code, name: option.name, market: option.market, type: 'index',
    price: 100, changeAmount: 1, changePct: 1, open: 99, high: 101, low: 98,
    previousClose: 99, limitUp: null, limitDown: null, turnoverPct: null,
    amplitudePct: null, volumeRatio: null, amountWan: null, peTtm: null,
    peStatic: null, pb: null, marketCapYi: null, floatMarketCapYi: null,
    listDate: null, industry: null, updatedAt: '2026-07-20T00:00:00.000Z', source: ['test'],
  };
}

describe('market overview index cards', () => {
  it('keeps all five configured cards when the quote response only contains three', () => {
    const cards = buildMarketIndexCards(
      options.map((option) => option.key),
      options,
      options.slice(0, 3).map(quote),
    );

    expect(cards).toHaveLength(5);
    expect(cards.map((card) => card.key)).toEqual(options.map((option) => option.key));
    expect(cards.slice(3).every((card) => card.quote === null)).toBe(true);
  });

  it('derives the latest value and return from preview klines when a quote is missing', () => {
    const points: KlinePoint[] = [
      { date: '2026-07-15', open: 100, high: 102, low: 99, close: 100, volume: 10 },
      { date: '2026-07-16', open: 99, high: 101, low: 96, close: 98, volume: 12 },
    ];

    expect(resolveMarketIndexSnapshot(null, points)).toMatchObject({
      price: 98,
      changeAmount: -2,
      changePct: -2,
      source: 'kline',
    });
  });
});
