import { describe, expect, it } from 'vitest';
import {
  buildMarketIndexCards,
  buildMarketIndexDetailTarget,
  resolveMarketIndexSnapshot,
  type MarketIndexOption,
} from '../marketIndexCards';
import type { KlinePoint, StockQuote } from '../types';

const options: MarketIndexOption[] = [
  { key: 'SH:000001', code: '000001', name: '上证指数', market: 'SH', prefixed: 'sh000001' },
  { key: 'SZ:399001', code: '399001', name: '深证成指', market: 'SZ', prefixed: 'sz399001' },
  { key: 'SZ:399006', code: '399006', name: '创业板指', market: 'SZ', prefixed: 'sz399006' },
  { key: 'SH:000852', code: '000852', name: '中证1000', market: 'SH', prefixed: 'sh000852' },
  { key: 'SH:932000', code: '932000', name: '中证2000', market: 'SH', prefixed: 'ft932000' },
  { key: 'US:SPX', code: 'SPX', name: '标普500', market: 'US', prefixed: 'usINX' },
  { key: 'US:DJIA', code: 'DJIA', name: '道琼斯', market: 'US', prefixed: 'usDJI' },
  { key: 'JP:N225', code: 'N225', name: '日经225', market: 'JP', prefixed: 'ftN225' },
  { key: 'KR:KS11', code: 'KS11', name: '韩国KOSPI', market: 'KR', prefixed: 'ftKS11' },
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
  it.each([
    ['SH:932000', 'ft932000'],
    ['US:SPX', 'usINX'],
    ['US:DJIA', 'usDJI'],
    ['JP:N225', 'ftN225'],
    ['KR:KS11', 'ftKS11'],
  ])('keeps the configured provider alias for %s detail navigation', (key, expected) => {
    const option = options.find((item) => item.key === key);
    expect(option).toBeDefined();
    expect(buildMarketIndexDetailTarget(option!, null).code).toBe(expected);
  });

  it('keeps all configured cards when the quote response is partial', () => {
    const cards = buildMarketIndexCards(
      options.map((option) => option.key),
      options,
      options.slice(0, 3).map(quote),
    );

    expect(cards).toHaveLength(options.length);
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
