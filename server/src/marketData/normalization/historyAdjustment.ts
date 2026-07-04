export type HistoryAdjustmentMode = 'none' | 'qfq' | 'hfq';

export interface HistoryAdjustmentFactor {
  effectiveDate: string;
  factor: number;
  priceOffset: number;
}

export interface HistoryPriceBar {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  previousClose?: number | null;
  [key: string]: unknown;
}

export interface QfqPriceOverride {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function applyHistoryAdjustment<T extends HistoryPriceBar>(
  bars: T[],
  factors: HistoryAdjustmentFactor[],
  overrides: QfqPriceOverride[],
  mode: Exclude<HistoryAdjustmentMode, 'none'>,
): Array<T | HistoryPriceBar> {
  if (factors.length === 0) return [...bars];
  const sortedFactors = [...factors].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate));
  const first = sortedFactors[0];
  const last = sortedFactors[sortedFactors.length - 1];
  let factorIndex = 0;

  const adjusted = [...bars]
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
    .map((bar) => {
      while (
        factorIndex + 1 < sortedFactors.length
        && sortedFactors[factorIndex + 1].effectiveDate <= bar.tradeDate
      ) {
        factorIndex += 1;
      }
      const factor = sortedFactors[factorIndex];
      return {
        ...bar,
        open: transformRawPrice(bar.open, factor, first, last, mode),
        high: transformRawPrice(bar.high, factor, first, last, mode),
        low: transformRawPrice(bar.low, factor, first, last, mode),
        close: transformRawPrice(bar.close, factor, first, last, mode),
        previousClose: bar.previousClose == null
          ? bar.previousClose
          : transformRawPrice(bar.previousClose, factor, first, last, mode),
      };
    });

  const rawDates = new Set(bars.map((bar) => bar.tradeDate));
  const earlyOverrides = overrides
    .filter((bar) => !rawDates.has(bar.tradeDate))
    .map((bar) => ({
      ...bar,
      ...(mode === 'hfq' ? {
        open: transformQfqToHfq(bar.open, first),
        high: transformQfqToHfq(bar.high, first),
        low: transformQfqToHfq(bar.low, first),
        close: transformQfqToHfq(bar.close, first),
      } : {}),
    }));

  return [...earlyOverrides, ...adjusted]
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

function transformRawPrice(
  price: number,
  factor: HistoryAdjustmentFactor,
  first: HistoryAdjustmentFactor,
  last: HistoryAdjustmentFactor,
  mode: Exclude<HistoryAdjustmentMode, 'none'>,
): number {
  const qfq = (
    price * factor.factor
    + factor.priceOffset
    - last.priceOffset
  ) / last.factor;
  return round(mode === 'qfq' ? qfq : transformQfqToHfq(qfq, first));
}

function transformQfqToHfq(
  qfqPrice: number,
  first: HistoryAdjustmentFactor,
): number {
  return (qfqPrice - first.priceOffset) / first.factor;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
