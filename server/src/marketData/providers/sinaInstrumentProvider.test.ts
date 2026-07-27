import { describe, expect, it, vi } from 'vitest';
import { SinaInstrumentProvider } from './sinaInstrumentProvider.js';

describe('SinaInstrumentProvider', () => {
  it('loads and normalizes the token-free full-market list', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('"3"', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { symbol: 'sh600001', code: '600001', name: '沪市样本' },
        { symbol: 'sz000001', code: '000001', name: '深市样本' },
        { symbol: 'bj920001', code: '920001', name: '北交所样本' },
      ]), { status: 200 }));
    const provider = new SinaInstrumentProvider('https://example.test', fetchMock);

    const result = await provider.fetchInstruments({});

    expect(result.items).toEqual([
      expect.objectContaining({ market: 'BJ', symbol: '920001', status: 'active' }),
      expect.objectContaining({ market: 'SH', symbol: '600001', status: 'active' }),
      expect.objectContaining({ market: 'SZ', symbol: '000001', status: 'active' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('filters the downloaded universe without another provider request', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('"2"', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { symbol: 'sh600001', code: '600001', name: '沪市样本' },
        { symbol: 'sz000001', code: '000001', name: '深市样本' },
      ]), { status: 200 }));
    const provider = new SinaInstrumentProvider('https://example.test', fetchMock);

    const result = await provider.fetchInstruments({ market: 'SH', symbol: '600001' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ market: 'SH', symbol: '600001' });
  });

  it('rejects a materially incomplete paged response', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('"100"', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { symbol: 'sh600001', code: '600001', name: '单条异常结果' },
      ]), { status: 200 }));
    const provider = new SinaInstrumentProvider('https://example.test', fetchMock);

    await expect(provider.fetchInstruments({})).rejects.toThrow('预计 100 条，实际仅返回 1 条');
  });

  it('enriches only requested new instruments with a listing date', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        '<a href="/corp/view/vCI_CorpInfoLink.php?stockid=688825&InMarketDate=202607">2026-07-27</a>',
        { status: 200 },
      ),
    );
    const provider = new SinaInstrumentProvider('https://example.test', fetchMock);

    const result = await provider.enrichInstruments([
      { market: 'SH', symbol: '688825', name: '长鑫存储', type: 'stock', status: 'active' },
    ]);

    expect(result[0].listDate).toBe('2026-07-27');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads BSE daily candles with share-volume units', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        result: {
          status: { code: 0 },
          data: [
            { day: '2026-04-13', open: '43.06', high: '54.93', low: '42', close: '51.67', volume: '11699032' },
            { day: '2026-04-14', open: '47', high: '52.56', low: '46.02', close: '50.71', volume: '8295290' },
          ],
        },
      }), { status: 200 }),
    );
    const provider = new SinaInstrumentProvider('https://example.test', fetchMock);

    const result = await provider.fetchDailyCandles({
      symbols: ['920012'],
      startDate: '2026-04-13',
      endDate: '2026-04-14',
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      symbol: '920012',
      date: '2026-04-13',
      volume: 11699032,
    });
    expect(result[1].previousClose).toBe(51.67);
  });

  it('maps full-market quotes for missing BSE daily updates', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('"1"', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        symbol: 'bj920012',
        code: '920012',
        name: '创达新材',
        trade: '51.67',
        settlement: '49.10',
        open: '49.50',
        high: '54.93',
        low: '48.20',
        volume: '11699032',
        amount: '600000000',
        turnoverratio: '12.34',
        mktcap: '120000',
        nmc: '80000',
        per: '22.5',
        pb: '2.1',
      }]), { status: 200 }));
    const provider = new SinaInstrumentProvider('https://example.test', fetchMock);

    const result = await provider.fetchCurrentDailyCandles!({
      instruments: [{ market: 'BJ', symbol: '920012' }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      symbol: '920012',
      previousClose: 49.10,
      volume: 11699032,
      turnover: 600000000,
      turnoverRatePct: 12.34,
      totalMarketCap: 1_200_000_000,
    });
  });
});
