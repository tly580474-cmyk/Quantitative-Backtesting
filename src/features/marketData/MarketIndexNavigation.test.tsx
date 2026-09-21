import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MarketDataPage from './MarketDataPage';
import { marketDataCache, INDEX_INTRADAY_CACHE_TTL_MS } from './marketDataCache';
import type { KlinePoint } from './types';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api/client', () => ({ apiFetch: request }));
const points = [{ date: '2026-09-18', close: 100 }, { date: '2026-09-21', close: 101 }] as KlinePoint[];
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('quant-market-index-selection-v1', JSON.stringify(['SH:000001', 'SZ:399001']));
  marketDataCache.indexPreviews = {};
  marketDataCache.klines = {};
  marketDataCache.klineCachedAt = {};
  marketDataCache.indexQuotes = [];
  marketDataCache.marketSentiment = undefined;
  marketDataCache.marketHealth = undefined;
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    if (path.includes('period=intraday')) return { items: [] };
    if (path.includes('period=day')) return { items: points };
    if (path.includes('market-sentiment') || path.includes('market-health')) throw new Error('no fixture');
    return { items: [] };
  });
  vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
function mount() { return render(<StrictMode><AntApp><MarketDataPage /></AntApp></StrictMode>); }
function chartRequests() { return request.mock.calls.filter(([path]) => String(path).includes('/kline?')); }

it('renders saved charts immediately on remount without new chart requests', async () => {
  const page = mount();
  await screen.findByRole('img', { name: '上证指数近30个交易日走势预览' });
  await screen.findByRole('img', { name: '深证成指近30个交易日走势预览' });
  const count = chartRequests().length;
  page.unmount();
  mount();
  expect(screen.getByRole('img', { name: '上证指数近30个交易日走势预览' })).toBeTruthy();
  expect(screen.queryByLabelText('上证指数走势预览加载中')).toBeNull();
  expect(chartRequests()).toHaveLength(count);
});

it('shows a ready chart without waiting for another index and keeps it during stale refresh', async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementation((path: string) => {
    if (path.includes('sz399001') && path.includes('/kline?')) return new Promise(resolve => { finish = resolve; });
    return path.includes('/kline?') ? Promise.resolve({ items: points }) : Promise.reject(new Error('no fixture'));
  });
  const page = mount();
  await screen.findByRole('img', { name: '上证指数近30个交易日走势预览' });
  expect(screen.getByLabelText('深证成指走势预览加载中')).toBeTruthy();
  finish({ items: points });
  await screen.findByRole('img', { name: '深证成指近30个交易日走势预览' });
  page.unmount();
  marketDataCache.indexPreviews.sh000001.checkedAt = Date.now() - INDEX_INTRADAY_CACHE_TTL_MS - 1;
  marketDataCache.klineCachedAt = {};
  request.mockRejectedValue(new Error('offline'));
  mount();
  expect(screen.getByRole('img', { name: '上证指数近30个交易日走势预览' })).toBeTruthy();
  await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('sh000001/kline?period=day')));
  expect(screen.getByRole('img', { name: '上证指数近30个交易日走势预览' })).toBeTruthy();
});
