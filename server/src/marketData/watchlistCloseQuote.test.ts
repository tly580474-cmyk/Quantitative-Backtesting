import { describe, expect, it } from 'vitest';
import { closingQuoteFromBars, confirmedClosingQuote, parseChinaQuoteTime, watchlistCloseCutoff } from './watchlistCloseQuote.js';
import type { KlinePoint, StockQuote } from './aStockDataService.js';

const base = { code: '000001', market: 'SZ', name: '平安银行', type: 'stock', price: 120,
  turnoverPct: 0, changePct: 0, updatedAt: '2026-08-31T01:20:00Z', source: ['腾讯财经'] } as StockQuote;
const bar = (date: string, close: number): KlinePoint => ({ date, close, open: 80, high: 120, low: 70,
  volume: 100, turnoverRatePct: 3.5 });

describe('watchlist closing snapshots', () => {
  it('excludes today before 15:00 and admits the current completed day after close', () => {
    expect(watchlistCloseCutoff(new Date('2026-08-31T01:20:00Z'), true)).toBe('2026-08-30');
    expect(watchlistCloseCutoff(new Date('2026-08-31T06:59:59Z'), true)).toBe('2026-08-30');
    expect(watchlistCloseCutoff(new Date('2026-08-31T07:00:00Z'), true)).toBe('2026-08-31');
    expect(watchlistCloseCutoff(new Date('2026-08-31T07:00:00Z'), false)).toBe('2026-08-30');
  });

  it('keeps Friday final values during Monday auction instead of resetting returns and turnover', () => {
    const snapshot = closingQuoteFromBars(base,
      [bar('2026-08-27', 100), bar('2026-08-28', 110), bar('2026-08-31', 120)], '2026-08-30', 'test');
    expect(snapshot).toMatchObject({ price: 110, changePct: 10, turnoverPct: 3.5,
      previousClose: 100, updatedAt: '2026-08-28T07:00:00.000Z' });
  });

  it('uses today after close and does not roll back to the preceding day', () => {
    const snapshot = closingQuoteFromBars(base,
      [bar('2026-08-28', 100), bar('2026-08-31', 120)], '2026-08-31', 'test');
    expect(snapshot).toMatchObject({ price: 120, changePct: 20, previousClose: 100,
      updatedAt: '2026-08-31T07:00:00.000Z' });
  });

  it('never substitutes opening price or zero for missing previous-close and turnover fields', () => {
    const snapshot = closingQuoteFromBars(base, [{ ...bar('2026-08-28', 110), turnoverRatePct: undefined }], '2026-08-30', 'test');
    expect(snapshot).toMatchObject({ price: 110, changePct: null, changeAmount: null, previousClose: null, turnoverPct: null });
    expect(closingQuoteFromBars(base, [bar('2026-08-31', 120)], '2026-08-30', 'test')).toBeNull();
  });

  it('accepts actual dated closing quotes, not request timestamps or auction quotes', () => {
    expect(confirmedClosingQuote(base, '2026-08-30')).toBeNull();
    expect(confirmedClosingQuote({ ...base, quoteTime: parseChinaQuoteTime('20260831092000') }, '2026-08-30')).toBeNull();
    expect(confirmedClosingQuote({ ...base, quoteTime: parseChinaQuoteTime('20260828150003') }, '2026-08-30'))
      .toMatchObject({ price: 120, updatedAt: '2026-08-28T07:00:03.000Z' });
    expect(parseChinaQuoteTime('invalid')).toBeUndefined();
  });
});
