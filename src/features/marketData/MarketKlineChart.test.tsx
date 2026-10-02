import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChart } from 'lightweight-charts';
import { usePriceColorStore } from '@/stores/usePriceColorStore';
import { getPriceColors } from '@/priceColors';
import MarketKlineChart from './MarketKlineChart';
import { SupertrendPrimitive } from '@/features/chart/SupertrendPrimitive';
import { calculateSupertrend, resolveSupertrendParams } from '@/features/indicators/supertrend';

vi.mock('@/features/chart/DailyIntradayModal', () => ({
  default: () => null, supportsHistoricalIntraday: () => false, hitsCandle: () => false,
}));
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: {}, HistogramSeries: {}, LineSeries: {},
  ColorType: { Solid: 'solid' }, LineStyle: { Dashed: 2 },
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({ applyOptions: vi.fn(), setData: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), priceToCoordinate: (price: number) => price })),
    priceScale: () => ({ applyOptions: vi.fn() }),
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(),
      subscribeSizeChange: vi.fn(), unsubscribeSizeChange: vi.fn(),
      fitContent: vi.fn(), setVisibleLogicalRange: vi.fn(), applyOptions: vi.fn(),
      getVisibleLogicalRange: () => null,
    }),
    panes: () => [{ getHeight: () => 480 }],
    subscribeCrosshairMove: vi.fn(), applyOptions: vi.fn(), remove: vi.fn(),
  })),
}));

const data = Array.from({ length: 20 }, (_, index) => ({
  date: `2026-09-${String(index + 1).padStart(2, '0')}`, open: 10, high: 11, low: 9, close: 10, volume: 1000,
}));
const visibility = { ma: false, rsi: false, macd: false, supertrend: true };

afterEach(() => { cleanup(); usePriceColorStore.getState().setMode('red-up'); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('market Supertrend integration', () => {
  it('recolors candles, volume and Supertrend without recreating the main chart', () => {
    const setColors = vi.spyOn(SupertrendPrimitive.prototype, 'setColors');
    const setData = vi.spyOn(SupertrendPrimitive.prototype, 'setData');
    render(<MarketKlineChart data={data} period="day" indicatorVisibility={visibility} />);
    const chart = vi.mocked(createChart).mock.results[0].value;
    const candles = chart.addSeries.mock.results[0].value;
    const volume = chart.addSeries.mock.results[1].value;
    const calls = setData.mock.calls.length;
    act(() => usePriceColorStore.getState().setMode('green-up'));
    expect(createChart).toHaveBeenCalledOnce();
    expect(candles.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ upColor: '#16a34a', downColor: '#ef4444', wickUpColor: '#16a34a', wickDownColor: '#ef4444' }));
    expect(volume.setData.mock.lastCall[0][0].color).toBe('#16a34a66');
    expect(setColors).toHaveBeenLastCalledWith(getPriceColors('green-up'));
    expect(setData).toHaveBeenCalledTimes(calls);
    act(() => usePriceColorStore.getState().setMode('red-up'));
    expect(candles.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ upColor: '#ef4444', downColor: '#16a34a' }));
    expect(createChart).toHaveBeenCalledOnce();
  });

  it('initializes the overlay again when symbol or instrument metadata rebuilds the chart', () => {
    const setData = vi.spyOn(SupertrendPrimitive.prototype, 'setData');
    const props = { data, period: 'day' as const, indicatorVisibility: visibility };
    const view = render(<MarketKlineChart {...props} symbol="000001" instrumentType="stock" />);
    expect(setData).toHaveBeenCalledWith(data.map((bar) => bar.date), data, calculateSupertrend(data));
    setData.mockClear();
    view.rerender(<MarketKlineChart {...props} symbol="000002" instrumentType="stock" />);
    expect(setData).toHaveBeenCalledOnce();
    setData.mockClear();
    view.rerender(<MarketKlineChart {...props} symbol="000002" instrumentType="index" />);
    expect(setData).toHaveBeenCalledOnce();
  });

  it('hides and restores the overlay without recreating the chart', () => {
    const setVisible = vi.spyOn(SupertrendPrimitive.prototype, 'setVisible');
    const view = render(<MarketKlineChart data={data} period="day" indicatorVisibility={visibility} />);
    expect(screen.getByText(/SUPERTREND/)).toBeTruthy();
    const chartCount = vi.mocked(createChart).mock.calls.length;
    view.rerender(<MarketKlineChart data={data} period="day" indicatorVisibility={{ ...visibility, supertrend: false }} />);
    expect(screen.queryByText(/SUPERTREND/)).toBeNull();
    expect(setVisible).toHaveBeenLastCalledWith(false);
    view.rerender(<MarketKlineChart data={data} period="day" indicatorVisibility={visibility} />);
    expect(setVisible).toHaveBeenLastCalledWith(true);
    expect(vi.mocked(createChart).mock.calls.length).toBe(chartCount);
  });

  it('recomputes the overlay and its effective parameters when the period changes', () => {
    const setData = vi.spyOn(SupertrendPrimitive.prototype, 'setData');
    const view = render(<MarketKlineChart data={data} period="day" indicatorVisibility={visibility} />);
    view.rerender(<MarketKlineChart data={data} period="year" indicatorVisibility={visibility} />);
    expect(screen.getByText(/SUPERTREND\(3, 2.5\)/)).toBeTruthy();
    expect(setData).toHaveBeenLastCalledWith(data.map((bar) => bar.date), data,
      calculateSupertrend(data, resolveSupertrendParams('year')));
  });
});
