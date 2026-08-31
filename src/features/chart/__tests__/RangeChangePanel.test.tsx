import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RangeChangePanel from '../RangeChangePanel';
import { useChartStore } from '@/stores/useChartStore';
import type { Candle } from '@/models';

afterEach(() => { cleanup(); useChartStore.getState().clear(); });

const candles: Candle[] = [
  { time: '2026-01-05', symbol: 'TEST', open: 10, high: 11, low: 9, close: 10, volume: 100 },
  { time: '2026-01-06', symbol: 'TEST', open: 10, high: 12, low: 10, close: 11, volume: 120 },
];

describe('RangeChangePanel', () => {
  it('keeps range analysis opt-in', () => {
    const onEnabledChange = vi.fn();
    render(<RangeChangePanel candles={candles} enabled={false} onEnabledChange={onEnabledChange} />);
    fireEvent.click(screen.getByRole('button', { name: /开启区间选择/ }));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('region', { name: '区间涨跌分析' })).toBeTruthy();
  });

  it('uses finance direction tokens without changing the computed result', () => {
    useChartStore.getState().setRangeLineState({ startTime: candles[0].time, endTime: candles[1].time, dragging: null });
    render(<RangeChangePanel candles={candles} enabled onEnabledChange={vi.fn()} />);
    expect(screen.getByText('+1.00 (+10.00%)').closest('.financial-positive')).not.toBeNull();
  });

  it('renders no phantom range toolbar without candles', () => {
    render(<RangeChangePanel candles={[]} enabled={false} onEnabledChange={vi.fn()} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});
