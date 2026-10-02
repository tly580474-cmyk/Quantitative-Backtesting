import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChart } from 'lightweight-charts';
import { usePriceColorStore } from '@/stores/usePriceColorStore';
import { SupertrendPrimitive } from '@/features/chart/SupertrendPrimitive';
import TrainingChart, { type TrainingIndicator } from './TrainingChart';

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: {}, HistogramSeries: {}, LineSeries: {},
  ColorType: { Solid: 'solid' }, LineStyle: { Dashed: 2 }, createSeriesMarkers: vi.fn(),
  createChart: vi.fn(() => {
    const scale = { fitContent: vi.fn() };
    return {
      addSeries: vi.fn(() => ({ applyOptions: vi.fn(), setData: vi.fn(), attachPrimitive: vi.fn() })),
      timeScale: () => scale, panes: () => [], subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(), applyOptions: vi.fn(), remove: vi.fn(),
    };
  }),
}));

afterEach(() => { cleanup(); usePriceColorStore.getState().setMode('red-up'); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('training chart color preference', () => {
  it('recolors both candle directions, volume, MACD and Supertrend while retaining the viewport and decision point', () => {
    const data = Array.from({ length: 40 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10), open: 10,
      high: 12, low: 8, close: index % 2 ? 9 : 11, volume: 1000,
    }));
    const onCrosshairChange = vi.fn();
    const setColors = vi.spyOn(SupertrendPrimitive.prototype, 'setColors');
    const indicators: TrainingIndicator[] = ['supertrend', 'macd'];
    render(<TrainingChart data={data} trades={[]} theme="light" indicators={indicators}
      drawingMode="none" drawings={[]} onChartPoint={vi.fn()} onCrosshairChange={onCrosshairChange} />);
    const chart = vi.mocked(createChart).mock.results[0].value;
    const [candles, volume, macd] = chart.addSeries.mock.results.map((result: { value: unknown }) => result.value);
    const beforeSnapshot = onCrosshairChange.mock.calls[0][0];
    act(() => usePriceColorStore.getState().setMode('green-up'));
    expect(createChart).toHaveBeenCalledOnce();
    expect(chart.timeScale().fitContent).toHaveBeenCalledOnce();
    expect(onCrosshairChange).toHaveBeenCalledOnce();
    expect(beforeSnapshot.index).toBe(39);
    expect(candles.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ upColor: '#16a34a', downColor: '#ef4444' }));
    const volumeData = volume.setData.mock.lastCall[0];
    expect(volumeData[0].color).toBe('#16a34a73');
    expect(volumeData[1].color).toBe('#ef444473');
    for (const bar of macd.setData.mock.lastCall[0]) {
      expect(bar.color).toBe(bar.value >= 0 ? '#16a34ab3' : '#ef4444b3');
    }
    expect(setColors).toHaveBeenLastCalledWith({ up: '#16a34a', down: '#ef4444' });
    expect(screen.getByLabelText('盘感训练 K 线图，绿涨红跌')).toBeTruthy();
  });
});
