import type { KlinePoint, StockKlinePeriod } from './aStockDataService.js';

export function mergeKlinePoints(
  databaseItems: KlinePoint[],
  onlineItems: KlinePoint[],
): KlinePoint[] {
  const byDate = new Map<string, KlinePoint>();
  for (const item of databaseItems) byDate.set(item.date, item);
  for (const item of onlineItems) byDate.set(item.date, item);
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function shouldRefreshDailyKline(
  latestDatabaseDate: string | undefined,
  tradeDate: string,
  isTradingSession: boolean,
): boolean {
  return isTradingSession || latestDatabaseDate !== tradeDate;
}

function isoWeekKey(dateText: string): string {
  const date = new Date(`${dateText}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

export function aggregateDailyKlines(
  items: KlinePoint[],
  period: Exclude<StockKlinePeriod, 'intraday' | 'day'>,
): KlinePoint[] {
  const groups = new Map<string, KlinePoint>();
  for (const item of items) {
    const key = period === 'week' ? isoWeekKey(item.date) : item.date.slice(0, 4);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...item });
      continue;
    }
    current.date = item.date;
    current.close = item.close;
    current.high = Math.max(current.high, item.high);
    current.low = Math.min(current.low, item.low);
    current.volume += item.volume;
    if (item.turnoverRatePct != null) {
      current.turnoverRatePct = (current.turnoverRatePct ?? 0) + item.turnoverRatePct;
    }
  }
  return Array.from(groups.values());
}
