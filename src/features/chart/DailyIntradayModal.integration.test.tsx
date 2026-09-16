import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DailyIntradayModal from './DailyIntradayModal';
import { apiFetch } from '@/api/client';

vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }));
vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' }, HistogramSeries: {}, LineSeries: {},
  createChart: () => ({
    addSeries: () => ({ setData: vi.fn() }),
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(),
      setVisibleRange: vi.fn(), getVisibleLogicalRange: () => null,
    }),
    subscribeCrosshairMove: vi.fn(), applyOptions: vi.fn(), remove: vi.fn(),
  }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('historical intraday request and display', () => {
  it('fetches a separate raw daily baseline and displays the same anchored return in summary and legend', async () => {
    vi.mocked(apiFetch).mockImplementation(async path => {
      if (path.includes('/minute?')) return {
        intervalMinutes: 1, sourceFiles: 1, truncated: false, elapsedMs: 1,
        items: [{ date: '2023-04-12 15:00:00', open: 10.07, high: 10.21, low: 10.02, close: 10.12, volume: 100, amount: 1012, previousClose: 10.1, change: 0.02, changePct: 0.2 }],
      };
      expect(path).toContain('adjustmentMode=none');
      return { adjustmentMode: 'none', items: [
        { date: '2023-04-11', close: 10.07 },
        { date: '2023-04-12', open: 10.07, high: 10.21, low: 10.02, close: 10.12 },
      ] };
    });
    render(<DailyIntradayModal open symbol="601566" date="2023-04-12" instrumentType="stock" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('涨跌幅 +0.5%')).toBeTruthy());
    expect(screen.getByText('+0.5%')).toBeTruthy();
    expect(screen.getByText('末价 10.12')).toBeTruthy();
    expect(screen.getByText('昨收（不复权） 10.07')).toBeTruthy();
  });
  it.each(['index', undefined] as const)('does not request or display minutes for type %s', async instrumentType => {
    render(<DailyIntradayModal open symbol="000985" date="2026-09-15" instrumentType={instrumentType} onClose={() => {}} />);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
