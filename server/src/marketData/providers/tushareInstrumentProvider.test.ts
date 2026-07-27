import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './provider.js';
import { TushareInstrumentProvider } from './tushareInstrumentProvider.js';

function apiResponse(items: unknown[][]): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: null,
    data: {
      fields: [
        'ts_code',
        'symbol',
        'name',
        'industry',
        'market',
        'exchange',
        'list_status',
        'list_date',
        'delist_date',
      ],
      items,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TushareInstrumentProvider', () => {
  it('normalizes listed, pending and delisted A-share instruments', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(apiResponse([
        ['600001.SH', '600001', '沪市样本', '银行', '主板', 'SSE', 'L', '20260701', null],
      ]))
      .mockResolvedValueOnce(apiResponse([
        ['001299.SZ', '001299', '待上市样本', null, '主板', 'SZSE', 'P', '20260801', null],
      ]))
      .mockResolvedValueOnce(apiResponse([
        ['920001.BJ', '920001', '退市样本', '制造业', '北交所', 'BSE', 'D', '20200102', '20260710'],
      ]));
    const provider = new TushareInstrumentProvider('token', 'https://example.test', fetchMock);

    const result = await provider.fetchInstruments({});

    expect(result.hasMore).toBe(false);
    expect(result.items).toEqual([
      expect.objectContaining({
        symbol: '920001',
        market: 'BJ',
        status: 'delisted',
        delistDate: '2026-07-10',
      }),
      expect.objectContaining({
        symbol: '600001',
        market: 'SH',
        status: 'active',
        listDate: '2026-07-01',
        industry: '银行',
      }),
      expect.objectContaining({
        symbol: '001299',
        market: 'SZ',
        status: 'pending',
        listDate: '2026-08-01',
      }),
    ]);
  });

  it('filters a full-universe response by market and symbol', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(apiResponse([
        ['600001.SH', '600001', '沪市样本', null, '主板', 'SSE', 'L', '20260701', null],
        ['000001.SZ', '000001', '深市样本', null, '主板', 'SZSE', 'L', '19910403', null],
      ]))
      .mockResolvedValueOnce(apiResponse([]))
      .mockResolvedValueOnce(apiResponse([]));
    const provider = new TushareInstrumentProvider('token', 'https://example.test', fetchMock);

    const result = await provider.fetchInstruments({ market: 'SZ', symbol: '000001' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ market: 'SZ', symbol: '000001' });
  });

  it('reports provider errors without exposing the token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        code: -2001,
        msg: '抱歉，您没有访问该接口的权限',
      }), { status: 200 }),
    );
    const provider = new TushareInstrumentProvider('secret-token', 'https://example.test', fetchMock);

    await expect(provider.fetchInstruments({})).rejects.toMatchObject({
      name: 'ProviderError',
      category: 'auth',
      retryable: false,
    });
    await expect(provider.fetchInstruments({})).rejects.not.toThrow('secret-token');
  });
});
