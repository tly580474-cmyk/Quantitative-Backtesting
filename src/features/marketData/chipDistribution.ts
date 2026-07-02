import type { KlinePoint } from './types';

export interface ChipBin {
  price: number;
  weight: number;
}

export interface ChipDistribution {
  bins: ChipBin[];
  latestClose: number;
  peakPrice: number;
  averageCost: number;
  profitRatio: number;
  costRange70: [number, number];
  concentration70: number;
  coverageRatio: number;
}

function quantilePrice(bins: ChipBin[], target: number): number {
  let cumulative = 0;
  for (const bin of bins) {
    cumulative += bin.weight;
    if (cumulative >= target) return bin.price;
  }
  return bins[bins.length - 1]?.price ?? 0;
}

/**
 * Point-in-time CYQ approximation matching Eastmoney's public chart model:
 * previous chips decay by the real daily turnover rate, while newly traded
 * chips are distributed over the day's price range with a triangular profile.
 */
export function calculateChipDistribution(
  candles: readonly KlinePoint[],
  binCount = 120,
): ChipDistribution | null {
  if (candles.length === 0 || binCount < 2) return null;
  const coveredCount = candles.filter((item) =>
    item.turnoverRatePct != null
    && Number.isFinite(item.turnoverRatePct)
    && item.turnoverRatePct >= 0
  ).length;
  const coverageRatio = coveredCount / candles.length;
  if (coverageRatio < 0.9) return null;

  const minPrice = Math.min(...candles.map((item) => item.low));
  const maxPrice = Math.max(...candles.map((item) => item.high));
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice <= 0 || maxPrice < minPrice) {
    return null;
  }

  const step = Math.max(0.01, (maxPrice - minPrice) / (binCount - 1));
  const prices = Array.from({ length: binCount }, (_, index) => minPrice + step * index);
  const chips = new Array<number>(binCount).fill(0);

  for (const candle of candles) {
    const turnover = candle.turnoverRatePct == null || !Number.isFinite(candle.turnoverRatePct)
      ? 0
      : Math.min(1, Math.max(0, candle.turnoverRatePct / 100));
    for (let index = 0; index < chips.length; index += 1) {
      chips[index] *= 1 - turnover;
    }
    if (turnover === 0) continue;

    const typicalPrice = (candle.open + candle.close + candle.high + candle.low) / 4;
    const dailyWeights = new Array<number>(binCount).fill(0);
    if (Math.abs(candle.high - candle.low) < 1e-8) {
      const index = Math.max(0, Math.min(binCount - 1, Math.round((typicalPrice - minPrice) / step)));
      dailyWeights[index] = 1;
    } else {
      const start = Math.max(0, Math.floor((candle.low - minPrice) / step));
      const end = Math.min(binCount - 1, Math.ceil((candle.high - minPrice) / step));
      for (let index = start; index <= end; index += 1) {
        const price = prices[index];
        dailyWeights[index] = price <= typicalPrice
          ? Math.max(0, (price - candle.low) / Math.max(typicalPrice - candle.low, 1e-8))
          : Math.max(0, (candle.high - price) / Math.max(candle.high - typicalPrice, 1e-8));
      }
    }

    const dailyTotal = dailyWeights.reduce((sum, value) => sum + value, 0);
    if (dailyTotal <= 0) continue;
    for (let index = 0; index < chips.length; index += 1) {
      chips[index] += turnover * dailyWeights[index] / dailyTotal;
    }
  }

  const total = chips.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const bins = prices.map((price, index) => ({ price, weight: chips[index] / total }));
  const latestClose = candles[candles.length - 1].close;
  const peak = bins.reduce((best, bin) => bin.weight > best.weight ? bin : best, bins[0]);
  const lower70 = quantilePrice(bins, 0.15);
  const upper70 = quantilePrice(bins, 0.85);

  return {
    bins,
    latestClose,
    peakPrice: peak.price,
    averageCost: bins.reduce((sum, bin) => sum + bin.price * bin.weight, 0),
    profitRatio: bins.reduce((sum, bin) => bin.price <= latestClose ? sum + bin.weight : sum, 0),
    costRange70: [lower70, upper70],
    concentration70: lower70 + upper70 > 0 ? (upper70 - lower70) / (lower70 + upper70) : 0,
    coverageRatio,
  };
}
