import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketBreadthChart, SentimentMetricStrip } from './MarketDataPage';
import type { MarketSentimentOverview } from './types';

const overview: MarketSentimentOverview = {
  modelVersion: 2, total: 5346, flat: 133, mainNetInYi: null, mainNetSampleCount: 0,
  totalAmountYi: 100, volumeBaselineYi: null, northboundNetYi: null,
  hs300AmplitudePct: null, hs300Amplitude20dPct: null, breakRate: null, ma5AbovePct: null,
  mainNetInTrend: [], factors: [], breadthIndexDivergence: 0,
  structure: 'balanced', structureLabel: '震荡均衡', structureDescription: '市场均衡',
  status: 'neutral', statusLabel: '中性震荡', notes: [],
  updatedAt: '2026-08-31T04:00:00Z', msi: -22.53, advancers: 2259, decliners: 2954,
  upLimit: 59, downLimit: 9,
  distribution: [
    { key: 'upLimit', label: '涨停', count: 20, tone: 'up', items: [] },
    { key: 'flat', label: '平盘', count: 0, tone: 'flat', items: [] },
    { key: 'downLimit', label: '跌停', count: 10, tone: 'down', items: [] },
  ],
};

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn((media: string) => ({
    media, matches: false, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })) });
});
afterEach(cleanup);

describe('Market overview widgets', () => {
  it('retains all five summary metrics', () => {
    const { container } = render(<SentimentMetricStrip overview={overview} />);
    expect(container.querySelectorAll('.market-sentiment-kpi')).toHaveLength(5);
    expect(screen.getByText('-22.53')).toBeTruthy();
    expect(screen.getByText('2,259 家')).toBeTruthy();
    expect(screen.getByText('9 家')).toBeTruthy();
  });

  it('uses proportional horizontal lengths, preserves desktop heights and bucket detail clicks', async () => {
    const { container } = render(<MarketBreadthChart overview={overview} onSelectStock={vi.fn()} />);
    const bars = container.querySelectorAll<HTMLElement>('.market-breadth-bar i');
    expect(bars[0].style.getPropertyValue('--breadth-width')).toBe('100%');
    expect(bars[1].style.getPropertyValue('--breadth-width')).toBe('0%');
    expect(bars[2].style.getPropertyValue('--breadth-width')).toBe('50%');
    expect(bars[0].style.getPropertyValue('--breadth-height')).toBe('116px');
    fireEvent.click(screen.getByRole('button', { name: '查看跌停的10只股票' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('跌停股票明细')).toBeTruthy();
  });

  it('keeps an all-zero distribution finite', () => {
    const empty = { ...overview, distribution: overview.distribution.map(item => ({ ...item, count: 0 })) };
    const { container } = render(<MarketBreadthChart overview={empty} onSelectStock={vi.fn()} />);
    for (const bar of container.querySelectorAll<HTMLElement>('.market-breadth-bar i')) {
      expect(bar.style.getPropertyValue('--breadth-width')).toBe('0%');
    }
  });
});
