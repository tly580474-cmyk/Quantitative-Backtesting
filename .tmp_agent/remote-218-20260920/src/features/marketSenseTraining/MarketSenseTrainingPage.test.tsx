import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
const bars = [
  { date: '2026-08-01', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
  { date: '2026-08-02', open: 10.5, high: 12, low: 10, close: 11.5, volume: 1200 },
];

beforeEach(() => {
  fetchMock.mockReset();
  sessionStorage.setItem('market-sense-training-session-v1', JSON.stringify({
    phase: 'finished',
    instrument: { code: '000001', name: '平安银行', market: '深市' },
    sessionBars: bars,
    cursor: 1,
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
            <Route path="/analysis" element={<div>行情分析目标页</div>} />
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
        dateRange: { from: '2026-08-01', to: '2026-08-02' },
      });
      expect(useCandleStore.getState().candles.map((item) => item.time)).toEqual(['2026-08-01', '2026-08-02']);
    });
  });
});
