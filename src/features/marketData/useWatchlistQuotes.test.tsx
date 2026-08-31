import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marketDataCache } from './marketDataCache';
import type { StockQuote } from './types';
import { useWatchlistQuotes } from './useWatchlistQuotes';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/api/client', () => ({ apiFetch: request }));

type QuoteOptions = RequestInit & { timeoutMs?: number };

function quote(code: string): StockQuote {
  return {
    code,
    name: code,
    market: 'SZ',
    type: 'stock',
    price: 10,
    changeAmount: 0,
    changePct: 0,
    open: 10,
    high: 10,
    low: 10,
    previousClose: 10,
    limitUp: null,
    limitDown: null,
    turnoverPct: null,
    amplitudePct: null,
    volumeRatio: null,
    amountWan: null,
    peTtm: null,
    peStatic: null,
    pb: null,
    marketCapYi: null,
    floatMarketCapYi: null,
    listDate: null,
    industry: null,
    updatedAt: '2026-08-31T01:30:00Z',
    source: ['test'],
  };
}

beforeEach(() => {
  request.mockReset();
  marketDataCache.quotes = {};
  marketDataCache.indexQuotes = undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useWatchlistQuotes request workers', () => {
  it('keeps four workers busy independently instead of waiting for a batch', async () => {
    const started = new Set<string>();
    const pending = new Map<string, { resolve: (value: StockQuote) => void; options: QuoteOptions }>();
    request.mockImplementation((path: string, options?: QuoteOptions) => {
      if (path.includes('/indices/')) return Promise.resolve({ items: [] });
      const code = path.match(/stocks\/(\w+)\//)?.[1] ?? '';
      started.add(code);
      return new Promise<StockQuote>(resolve => {
        pending.set(code, { resolve, options: options ?? {} });
      });
    });

    const codes = ['000001', '000002', '000003', '000004', '000005'];
    const { result, unmount } = renderHook(() => useWatchlistQuotes(codes));
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.refresh('live'); });

    await waitFor(() => expect(started.size).toBe(4));
    expect(started).toEqual(new Set(['000001', '000002', '000003', '000004']));
    expect([...pending.values()].every(({ options }) => options.timeoutMs === 4_000)).toBe(true);

    act(() => { pending.get('000001')?.resolve(quote('000001')); });
    await waitFor(() => expect(started.has('000005')).toBe(true));
    expect(started.size).toBe(5);

    act(() => {
      for (const code of codes.slice(1)) pending.get(code)?.resolve(quote(code));
    });
    await act(async () => { await refresh; });
    expect(result.current.failedCodes).toEqual([]);
    unmount();
  });

  it('aborts stock and index requests when the list key changes', async () => {
    const aborted: string[] = [];
    const started = new Set<string>();
    request.mockImplementation((path: string, options?: QuoteOptions) => {
      if (path.includes('/indices/')) {
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted.push('indices');
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }
      const code = path.match(/stocks\/(\w+)\//)?.[1] ?? '';
      started.add(code);
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted.push(code);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    });

    const { result, rerender } = renderHook(({ codes }: { codes: string[] }) => useWatchlistQuotes(codes), {
      initialProps: { codes: ['000001', '000002', '000003', '000004'] },
    });
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.refresh('live'); });
    await waitFor(() => expect(started.size).toBe(4));

    rerender({ codes: ['000005'] });
    await waitFor(() => expect(aborted).toHaveLength(5));
    expect(new Set(aborted)).toEqual(new Set(['indices', '000001', '000002', '000003', '000004']));
    await act(async () => { await refresh; });
  });

  it('allows the close snapshot requests more time than live polling', async () => {
    request.mockImplementation((path: string) => path.includes('/indices/')
      ? Promise.resolve({ items: [] })
      : Promise.resolve(quote(path.match(/stocks\/(\w+)\//)?.[1] ?? '')));
    const { result, unmount } = renderHook(() => useWatchlistQuotes(['000001']));
    await act(async () => { await result.current.refresh('close'); });

    const stockCall = request.mock.calls.find(([path]) => String(path).includes('/stocks/'));
    expect(stockCall?.[1]).toMatchObject({ timeoutMs: 30_000 });
    unmount();
  });
});
