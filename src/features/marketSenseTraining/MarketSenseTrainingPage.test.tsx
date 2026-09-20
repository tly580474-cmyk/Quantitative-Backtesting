import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/api/client';
import { createTrainingPortfolio } from './engine';
import { useCandleStore } from '@/stores/useCandleStore';
import MarketSenseTrainingPage from './MarketSenseTrainingPage';

vi.mock('@/api/client', () => ({ apiFetch: vi.fn() }));
vi.mock('./TrainingChart', () => ({
  default: () => <div data-testid="training-chart" />,
}));

const fetchMock = vi.mocked(apiFetch);
const bars = Array.from({ length: 82 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10);
  const open = 10 + index / 10;
  return { date, open, high: open + 1, low: open - 1, close: open + 0.5, volume: 1000 + index };
});

function AnalysisTarget() {
  const location = useLocation();
  const range = location.state?.marketSenseTrainingRange;
  return <div>
    行情分析目标页
    <span data-testid="training-range">{range ? `${range.startTime}/${range.endTime}` : ''}</span>
  </div>;
}

beforeEach(() => {
  fetchMock.mockReset();
  sessionStorage.setItem('market-sense-training-session-v1', JSON.stringify({
    phase: 'finished',
    instrument: { code: '000001', name: '平安银行', market: '深市' },
    sessionBars: bars,
    cursor: bars.length - 1,
    lots: 1,
    portfolio: createTrainingPortfolio(),
    indicators: ['ma'],
    drawingMode: 'none',
    drawings: [],
    draftPoint: null,
  }));
  useCandleStore.setState({ candles: [], importResult: null, loading: false });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  useCandleStore.setState({ candles: [], importResult: null, loading: false });
});

describe('MarketSenseTrainingPage analysis navigation', () => {
  it('shows the action after training and opens the revealed stock in analysis', async () => {
    fetchMock.mockResolvedValue({ items: [...bars].reverse() });
    render(
      <MemoryRouter initialEntries={['/market-sense-training']}>
        <AntApp>
          <Routes>
            <Route path="/market-sense-training" element={<MarketSenseTrainingPage />} />
            <Route path="/analysis" element={<AnalysisTarget />} />
          </Routes>
        </AntApp>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /前往行情分析/ }));

    expect(await screen.findByText('行情分析目标页')).toBeTruthy();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/stocks/000001/kline?period=day&fullHistory=true'));
      expect(useCandleStore.getState().importResult).toMatchObject({
        symbol: '000001',
        name: '平安银行',
        dateRange: { from: bars[0].date, to: bars[bars.length - 1].date },
      });
      expect(useCandleStore.getState().candles.map((item) => item.time)).toEqual(bars.map((item) => item.date));
      expect(screen.getByTestId('training-range').textContent).toBe(
        `${bars[79].date}/${bars[bars.length - 1].date}`,
      );
    });
  });
});
