import type { KlinePoint, StockQuote } from './aStockDataService.js';

const SHANGHAI_OFFSET = 8 * 3_600_000;

/** Before today's close, today's auction/intraday bar must never replace the
 * last completed session. Calendar holidays cannot contribute a new close. */
export function watchlistCloseCutoff(now: Date, openDate: boolean | null): string {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET);
  const weekday = local.getUTCDay();
  if (local.getUTCHours() < 15 || weekday === 0 || weekday === 6 || openDate === false) {
    local.setUTCDate(local.getUTCDate() - 1);
  }
  return local.toISOString().slice(0, 10);
}

export function parseChinaQuoteTime(raw: string | undefined): string | undefined {
  if (!raw || !/^\d{14}$/.test(raw)) return undefined;
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const time = `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`;
  const parsed = new Date(`${date}T${time}+08:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export function confirmedClosingQuote(quote: StockQuote | null, cutoff: string): StockQuote | null {
  if (!quote?.quoteTime || quote.price == null || !Number.isFinite(quote.price) || quote.price <= 0) return null;
  const local = new Date(Date.parse(quote.quoteTime) + SHANGHAI_OFFSET);
  if (!Number.isFinite(local.getTime()) || local.getUTCHours() < 15
    || local.toISOString().slice(0, 10) > cutoff) return null;
  return { ...quote, updatedAt: quote.quoteTime, source: [...quote.source, '收盘快照'] };
}

/** All six list fields share a dated snapshot. Missing previous close remains
 * unknown; using the opening price here would invent a daily return. */
export function closingQuoteFromBars(
  base: StockQuote,
  bars: KlinePoint[],
  cutoff: string,
  source: string,
): StockQuote | null {
  const completed = bars.filter(bar => /^\d{4}-\d{2}-\d{2}$/.test(bar.date)
    && bar.date <= cutoff && Number.isFinite(bar.close) && bar.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = completed.at(-1);
  if (!latest) return null;
  const previousClose = latest.previousClose ?? completed.at(-2)?.close ?? null;
  const changeAmount = previousClose != null && previousClose > 0 ? latest.close - previousClose : null;
  return { ...base, price: latest.close, previousClose, changeAmount,
    changePct: latest.changePct ?? (changeAmount != null && previousClose ? changeAmount / previousClose * 100 : null),
    turnoverPct: latest.turnoverRatePct ?? null, open: latest.open, high: latest.high, low: latest.low,
    amountWan: latest.amount == null ? null : latest.amount / 10_000,
    amplitudePct: previousClose != null && previousClose > 0 ? (latest.high - latest.low) / previousClose * 100 : null,
    volumeRatio: null, updatedAt: `${latest.date}T07:00:00.000Z`,
    quoteTime: `${latest.date}T07:00:00.000Z`, source: [source] };
}
