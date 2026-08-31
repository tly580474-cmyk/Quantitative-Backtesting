import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWatchlistQuote } from './aStockDataService.js';

function provider(quoteTime: string, rows: unknown[][], adjustedOnly = false) {
  const fields = Array.from({ length: 55 }, () => '');
  fields[1] = '平安银行'; fields[3] = '130'; fields[4] = '110'; fields[30] = quoteTime;
  fields[32] = '18.18'; fields[38] = '3.10';
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('qt.gtimg.cn')) return new Response(`v_sz000001="${fields.join('~')}";`);
    expect(String(url)).toContain('fqkline/get');
    expect(new URL(String(url)).searchParams.get('param')).toContain(',0');
    return new Response(JSON.stringify({ data: { sz000001: { [adjustedOnly ? 'qfqday' : 'day']: rows } } }));
  }));
}
afterEach(() => vi.unstubAllGlobals());

describe('watchlist dated quote fallback', () => {
  it('uses the last completed online bar when Monday auction has reset the live quote', async () => {
    provider('20260831092000', [
      ['2026-08-27', 99, 100, 105, 95, 100],
      ['2026-08-28', 105, 110, 115, 100, 100],
      ['2026-08-31', 120, 130, 130, 120, 1],
    ]);
    expect(await fetchWatchlistQuote('000001', 'close', new Date('2026-08-31T01:20:00Z')))
      .toMatchObject({ type: 'stock', price: 110, changePct: 10, turnoverPct: null,
        updatedAt: '2026-08-28T07:00:00.000Z' });
  });

  it('uses the dated current close including turnover before the local daily update', async () => {
    provider('20260831150003', []);
    expect(await fetchWatchlistQuote('000001', 'close', new Date('2026-08-31T07:05:00Z')))
      .toMatchObject({ price: 130, changePct: 18.18, turnoverPct: 3.1,
        updatedAt: '2026-08-31T07:00:03.000Z' });
  });

  it('reports unavailable instead of rolling back to Friday after Monday close', async () => {
    provider('20260828150003', [['2026-08-28', 105, 110, 115, 100, 100]]);
    await expect(fetchWatchlistQuote('000001', 'close', new Date('2026-08-31T07:05:00Z')))
      .rejects.toThrow('暂无可确认的当日收盘数据');
  });

  it('does not substitute adjusted historical prices for unadjusted watchlist prices', async () => {
    provider('20260831092000', [['2026-08-28', 5, 6, 7, 4, 100]], true);
    await expect(fetchWatchlistQuote('000001', 'close', new Date('2026-08-31T01:20:00Z')))
      .rejects.toThrow('暂无可确认的收盘数据');
  });
});
