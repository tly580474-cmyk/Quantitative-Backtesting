import { Suspense } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketAnalysisRoute } from './App';
import { apiFetch } from './api/client';
import { useCandleStore } from './stores/useCandleStore';
import { useDrawingStore } from './stores/useDrawingStore';
import type { Candle } from './models';

vi.mock('./api/client', () => ({ apiFetch: vi.fn() }));
vi.mock('./components/IndicatorPanel', () => ({ default: () => <div>指标配置</div> }));
vi.mock('./features/chart/ChartContainer', () => ({
  default: ({ sourceCandles, period, drawingContextKey }: {
    sourceCandles: Candle[];
    period: string;
    drawingContextKey?: string;
  }) => <div data-testid="chart-source" data-period={period} data-drawing-context={drawingContextKey}>
    {sourceCandles.map((c) => c.close).join(',')}
  </div>,
}));

const daily: Candle[] = [
  { symbol: 'TEST', time: '2026-08-28', open: 10, high: 12, low: 9, close: 11, volume: 100 },
];
const catalog = { status: 'ready', firstDate: '2026-08-01', lastDate: '2026-08-28' };
const bars = (interval: number, close: number) => ({
  intervalMinutes: interval, sourceFiles: 1, truncated: false, elapsedMs: 10,
  items: [{ date: '2026-08-28 09:35', open: close, high: close, low: close, close, volume: 100, amount: 1000 }],
});
const fetchMock = vi.mocked(apiFetch);

function renderRoute() {
  return render(<MemoryRouter><AntApp><Suspense fallback={<span>图表加载中</span>}>
    <MarketAnalysisRoute />
  </Suspense></AntApp></MemoryRouter>);
}

beforeEach(() => {
  localStorage.clear();
  useDrawingStore.setState({
    contextKey: '', drawings: [], draft: null, selectedId: null, tool: 'select',
    past: [], future: [], canUndo: false, canRedo: false,
  });
  fetchMock.mockReset();
  useCandleStore.setState({ candles: daily, importResult: null });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null,
  })) });
});
afterEach(() => { cleanup(); useCandleStore.setState({ candles: [], importResult: null }); });

describe('MarketAnalysisRoute drawing tools', () => {
  it('scopes drawings to the chart context and makes drawing mutually exclusive with range selection', async () => {
    renderRoute();
    const chart = await screen.findByTestId('chart-source');
    expect(JSON.parse(chart.getAttribute('data-drawing-context') ?? '{}')).toMatchObject({
      instrument: 'TEST', period: 'day', adjustmentMode: 'none',
    });

    fireEvent.click(screen.getByRole('button', { name: /开启区间选择/ }));
    expect(screen.getByRole('button', { name: /关闭区间选择/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '画线工具' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /水平线/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /开启区间选择/ })).toBeTruthy());
    expect(useDrawingStore.getState().tool).toBe('horizontal');
  });
});

describe('MarketAnalysisRoute minute loading', () => {
  it('shows catalog loading and never labels stale minute data as a new period', async () => {
    let resolveCatalog!: (value: typeof catalog) => void;
    let resolveFive!: (value: ReturnType<typeof bars>) => void;
    const pendingCatalog = new Promise<typeof catalog>((resolve) => { resolveCatalog = resolve; });
    const pendingFive = new Promise<ReturnType<typeof bars>>((resolve) => { resolveFive = resolve; });
    let catalogReads = 0;
    fetchMock.mockImplementation((path) => {
      if (path.endsWith('/catalog')) return ++catalogReads === 1 ? pendingCatalog : Promise.resolve(catalog);
      return path.includes('interval=5&') ? pendingFive : Promise.resolve(bars(1, 21));
    });
    renderRoute();
    await screen.findByTestId('chart-source');
    fireEvent.click(screen.getByRole('radio', { name: '1分' }));
    expect(await screen.findByRole('status', { name: '正在加载分钟行情' })).toBeTruthy();
    expect(screen.queryByText('当前范围暂无分钟行情')).toBeNull();
    await act(async () => { resolveCatalog(catalog); });
    await waitFor(() => expect(screen.getByTestId('chart-source').textContent).toBe('21'));
    fireEvent.click(screen.getByRole('radio', { name: '5分' }));
    await screen.findByRole('status', { name: '正在加载分钟行情' });
    expect(screen.queryByTestId('chart-source')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '日K' }));
    await waitFor(() => expect(screen.getByTestId('chart-source').textContent).toBe('11'));
    await act(async () => { resolveFive(bars(5, 99)); });
    expect(screen.getByTestId('chart-source').getAttribute('data-period')).toBe('day');
    expect(screen.getByTestId('chart-source').textContent).toBe('11');
  });

  it('retries a failed catalog from an inline error state', async () => {
    let attempts = 0;
    fetchMock.mockImplementation((path) => {
      if (path.endsWith('/catalog')) return ++attempts === 1
        ? Promise.reject(new Error('目录连接失败')) : Promise.resolve(catalog);
      return Promise.resolve(bars(1, 21));
    });
    renderRoute();
    await screen.findByTestId('chart-source');
    fireEvent.click(screen.getByRole('radio', { name: '1分' }));
    await screen.findByText('目录连接失败');
    fireEvent.click(screen.getByRole('button', { name: '重新加载分钟行情' }));
    await waitFor(() => expect(screen.getByTestId('chart-source').textContent).toBe('21'));
    expect(attempts).toBe(2);
  });
});
