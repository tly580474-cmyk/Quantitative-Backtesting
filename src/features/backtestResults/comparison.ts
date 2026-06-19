import type { Candle, EquityPoint } from '@/models';
import type { EquitySeriesPoint } from './EquityChart';

export function toEquitySeries(points: EquityPoint[]): EquitySeriesPoint[] {
  return points.map((point) => ({ time: point.time, value: point.equity }));
}

export function normalizeDcaEquity(points: EquityPoint[]): EquitySeriesPoint[] {
  return points
    .filter((point) => (point.contributedCapital ?? 0) > 0)
    .map((point) => ({
      time: point.time,
      value: point.equity / point.contributedCapital! * 100,
    }));
}

export function normalizeBenchmark(
  candles: Candle[],
  startTime: string,
  endTime: string,
): EquitySeriesPoint[] {
  const period = candles.filter((candle) => candle.time >= startTime && candle.time <= endTime && candle.close > 0);
  const base = period[0]?.close;
  if (!base) return [];
  return period.map((candle) => ({
    time: candle.time,
    value: candle.close / base * 100,
  }));
}
