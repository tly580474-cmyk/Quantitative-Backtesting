import type { Candle } from '@/models';

export type ChartPeriod = 'day' | 'week' | 'month';

export function aggregateCandles(
  candles: readonly Candle[],
  period: ChartPeriod,
): Candle[] {
  if (period === 'day' || candles.length === 0) return [...candles];
  const sorted = [...candles].sort((a, b) => a.time.localeCompare(b.time));
  const groups = new Map<string, Candle[]>();
  for (const candle of sorted) {
    const key = period === 'week' ? weekKey(candle.time) : candle.time.slice(0, 7);
    const group = groups.get(key);
    if (group) group.push(candle);
    else groups.set(key, [candle]);
  }
  const result: Candle[] = [];
  let previousClose: number | undefined;
  for (const group of groups.values()) {
    const first = group[0];
    const last = group[group.length - 1];
    const volumeValues = group.map((item) => item.volume).filter(isNumber);
    const turnoverValues = group.map((item) => item.turnover).filter(isNumber);
    const turnoverRateValues = group.map((item) => item.turnoverRatePct).filter(isNumber);
    const change = previousClose == null ? undefined : last.close - previousClose;
    result.push({
      time: last.time,
      symbol: last.symbol || first.symbol,
      open: first.open,
      high: Math.max(...group.map((item) => item.high)),
      low: Math.min(...group.map((item) => item.low)),
      close: last.close,
      change,
      changePercent: change == null || previousClose == null || previousClose === 0
        ? undefined
        : change / previousClose * 100,
      volume: volumeValues.length > 0
        ? volumeValues.reduce((sum, value) => sum + value, 0)
        : undefined,
      turnover: turnoverValues.length > 0
        ? turnoverValues.reduce((sum, value) => sum + value, 0)
        : undefined,
      turnoverRatePct: turnoverRateValues.length > 0
        ? turnoverRateValues.reduce((sum, value) => sum + value, 0)
        : undefined,
    });
    previousClose = last.close;
  }
  return result;
}

function weekKey(time: string): string {
  const date = new Date(`${time.slice(0, 10)}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return date.toISOString().slice(0, 10);
}

function isNumber(value: number | undefined): value is number {
  return value != null && Number.isFinite(value);
}
