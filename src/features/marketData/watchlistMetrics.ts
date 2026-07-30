import type { KlinePoint, StockQuote, StockSearchItem } from './types';

export interface WatchlistMetrics {
  currentPrice: number | null;
  returnSinceAddedPct: number | null;
  riskPrice: number | null;
  riskDistancePct: number | null;
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizedCandles(candles: KlinePoint[]): KlinePoint[] {
  return [...new Map(
    candles
      .filter((item) => positive(item.close) != null)
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((item) => [item.date, item]),
  ).values()];
}

export function resolveWatchlistBaselinePrice(
  item: StockSearchItem,
  quote: StockQuote | null | undefined,
  candles: KlinePoint[],
): number | null {
  const ordered = normalizedCandles(candles);
  return positive(item.addedPrice)
    ?? positive(quote?.price)
    ?? positive(ordered[ordered.length - 1]?.close);
}

export function calculateWatchlistMetrics(
  item: StockSearchItem,
  quote: StockQuote | null | undefined,
  candles: KlinePoint[],
): WatchlistMetrics {
  const ordered = normalizedCandles(candles);
  const currentPrice = positive(quote?.price) ?? positive(ordered[ordered.length - 1]?.close);
  const baselinePrice = positive(item.addedPrice);
  const returnSinceAddedPct = currentPrice != null && baselinePrice != null
    ? (currentPrice / baselinePrice - 1) * 100
    : null;

  if (currentPrice == null || ordered.length < 21) {
    return {
      currentPrice,
      returnSinceAddedPct,
      riskPrice: null,
      riskDistancePct: null,
    };
  }

  const window = ordered.slice(-21);
  const trueRanges = window.slice(1).map((candle, index) => {
    const previousClose = window[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  const atr20 = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
  const structureLow = Math.min(...window.slice(-20).map((item) => item.low));
  const riskPrice = Math.min(currentPrice, Math.max(structureLow, currentPrice - 2 * atr20));

  return {
    currentPrice,
    returnSinceAddedPct,
    riskPrice,
    riskDistancePct: (riskPrice / currentPrice - 1) * 100,
  };
}
