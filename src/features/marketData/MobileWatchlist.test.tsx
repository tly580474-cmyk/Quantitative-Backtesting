import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MarketDataPage from './MarketDataPage';
import { marketDataCache } from './marketDataCache';
import type { StockQuote, StockSearchItem } from './types';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/api/client', () => ({ apiFetch: request }));
vi.mock('@/components/mobile/useMobileLayout', () => ({ useMobileLayout: () => true }));

const stocks: StockSearchItem[] = [
  { code: '600519', name: '贵州茅台', market: 'SH', type: 'stock', addedPrice: 100 },
  { code: '000001', name: '平安银行', market: 'SZ', type: 'stock', addedPrice: 200 },
];
function session() {
  return { serverTime: new Date().toISOString(), sessionDate: '2026-08-31', phase: 'trading',
    nextCheckAt: new Date(Date.now() + 3_600_000).toISOString(), closeRefreshKey: null };
}
function quote(stock: StockSearchItem, price: number): StockQuote {
  return { ...stock, price, changeAmount: 1, changePct: 2.5, turnoverPct: 3.2,
    open: null, high: null, low: null, previousClose: null, limitUp: null, limitDown: null,
    amplitudePct: null, volumeRatio: null, amountWan: null, peTtm: null, peStatic: null,
    pb: null, marketCapYi: null, floatMarketCapYi: null, listDate: null, industry: null,
    updatedAt: '2026-08-31T01:30:00Z', source: ['test'] };
}
function mount(items = stocks) {
  marketDataCache.watchlist = items;
  const open = vi.fn();
  render(<AntApp><MarketDataPage view="watchlist" onOpenDetail={open} /></AntApp>);
  return open;
}
async function refreshList() {
  const button = screen.getByRole('button', { name: '刷新自选及指数' });
  await waitFor(() => expect(button.classList.contains('ant-btn-loading')).toBe(false));
  fireEvent.click(button);
}

beforeEach(() => {
  request.mockReset();
  localStorage.clear();
  marketDataCache.quotes = {};
  marketDataCache.indexQuotes = undefined;
  marketDataCache.watchlist = undefined;
  marketDataCache.selectedCode = undefined;
  vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  request.mockImplementation(async (path: string) => {
    if (path.endsWith('/watchlist-session')) return session();
    if (path === '/api/market-data/indices/quotes') return { items: [quote({ code: '000001', name: '上证指数', market: 'SH', type: 'index' }, 3952.18)] };
    const item = stocks.find(stock => path === `/api/market-data/stocks/${stock.code}/quote?profile=false`);
    if (item) return quote(item, item.code === '600519' ? 110 : 190);
    throw new Error(`Unexpected heavy request: ${path}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('compact mobile watchlist', () => {
  it('requests closing snapshots for both the securities and the index rail outside trading hours', async () => {
    request.mockImplementation(async (path: string) => {
      if (path.endsWith('/watchlist-session')) return { ...session(), phase: 'closed', closeRefreshKey: '2026-08-28:final' };
      if (path === '/api/market-data/indices/quotes?snapshot=close') return { items: [quote({ code: '000001', name: '上证指数', market: 'SH', type: 'index' }, 3952.18)] };
      const item = stocks.find(stock => path === `/api/market-data/stocks/${stock.code}/quote?profile=false&snapshot=close`);
      if (item) return quote(item, 110);
      throw new Error(`Unexpected live request: ${path}`);
    });
    mount();
    await screen.findByText('3952.18');
    await within(screen.getByRole('button', { name: '查看贵州茅台详情' })).findByText('110.00');
    expect(screen.getByLabelText('行情刷新状态').textContent).toBe('休市 · 最近收盘数据');
    expect(request.mock.calls.map(([path]) => path).sort()).toEqual([
      '/api/market-data/indices/quotes?snapshot=close',
      '/api/market-data/stocks/000001/quote?profile=false&snapshot=close',
      '/api/market-data/stocks/600519/quote?profile=false&snapshot=close',
      '/api/market-data/watchlist-session',
    ]);
  });

  it('loads only list quotes and indices, shows all six fields, and opens secondary details', async () => {
    const open = mount();
    const row = screen.getByRole('button', { name: '查看贵州茅台详情' });
    await within(row).findByText('110.00');
    expect(within(row).getByText('600519')).toBeTruthy();
    expect(within(row).getByText('+2.50%')).toBeTruthy();
    expect(within(row).getByLabelText('换手率').textContent).toBe('3.20%');
    expect(within(row).getByLabelText('自选后收益').textContent).toBe('+10.00%');
    expect(await screen.findByText('3952.18')).toBeTruthy();
    expect(request.mock.calls.map(([path]) => path).sort()).toEqual([
      '/api/market-data/indices/quotes', '/api/market-data/stocks/000001/quote?profile=false', '/api/market-data/stocks/600519/quote?profile=false', '/api/market-data/watchlist-session',
    ]);
    expect(screen.queryByText('价格走势')).toBeNull();
    expect(screen.queryByText('自选评分排名')).toBeNull();
    fireEvent.click(row);
    expect(open).toHaveBeenCalledWith(stocks[0]);
    fireEvent.click(screen.getByRole('button', { name: '查看上证指数行情' }));
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'sh000001', type: 'index' }));
  });

  it('refreshes every quote without replacing the original return baseline', async () => {
    mount();
    await screen.findByText('190.00');
    request.mockImplementation(async (path: string) => path.endsWith('/watchlist-session') ? session() : path.includes('/indices/') ? { items: [] }
      : quote(stocks[path.includes('600519') ? 0 : 1], path.includes('600519') ? 120 : 220));
    await refreshList();
    await screen.findByText('220.00');
    expect(within(screen.getByRole('button', { name: '查看贵州茅台详情' })).getByLabelText('自选后收益').textContent).toBe('+20.00%');
    expect(within(screen.getByRole('button', { name: '查看平安银行详情' })).getByLabelText('自选后收益').textContent).toBe('+10.00%');
    expect(marketDataCache.watchlist?.map(item => item.addedPrice)).toEqual([100, 200]);
  });

  it('keeps missing baselines unknown and preserves the last quote when a refresh fails', async () => {
    mount([{ ...stocks[0], addedPrice: undefined }, stocks[1]]);
    await screen.findByText('110.00');
    request.mockImplementation(async (path: string) => {
      if (path.endsWith('/watchlist-session')) return session();
      if (path.includes('/indices/')) return { items: [] };
      if (path.includes('600519')) throw new Error('offline');
      return quote(stocks[1], 205);
    });
    await refreshList();
    await screen.findByText('205.00');
    await screen.findByText('1 只证券刷新失败，保留上次行情，可点刷新重试。');
    const row = screen.getByRole('button', { name: '查看贵州茅台详情' });
    expect(within(row).getByText('110.00')).toBeTruthy();
    expect(within(row).getByLabelText('自选后收益').textContent).toBe('—');
    expect(marketDataCache.watchlist?.[0].addedPrice).toBeUndefined();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索我的自选' }), { target: { value: '000001' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: '查看贵州茅台详情' })).toBeNull());
    expect(screen.getByRole('button', { name: '查看平安银行详情' })).toBeTruthy();
  });
});
