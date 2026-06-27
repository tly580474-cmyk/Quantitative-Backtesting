import type { Candle } from '@/models';

export interface StrategySignalParams {
  period: number;
}

export interface VolumeResult {
  volume: (number | null)[];
  volumeAverage: (number | null)[];
  volumeRatio: (number | null)[];
}

export interface HighLowBreakoutResult {
  previousHigh: (number | null)[];
  previousLow: (number | null)[];
}

export interface DrawdownResult {
  peak: (number | null)[];
  drawdown: (number | null)[];
}

/**
 * Raw volume plus its rolling average and ratio.  A ratio of 1.5 means the
 * current volume is 1.5 times the average volume of the configured window.
 */
export function calculateVolume(
  candles: Candle[],
  params: StrategySignalParams,
): VolumeResult {
  const volume = candles.map((candle) =>
    candle.volume != null && Number.isFinite(candle.volume) ? candle.volume : null
  );
  const volumeAverage: (number | null)[] = new Array(candles.length).fill(null);
  const volumeRatio: (number | null)[] = new Array(candles.length).fill(null);
  const { period } = params;
  if (period < 1) return { volume, volumeAverage, volumeRatio };

  let sum = 0;
  let validCount = 0;
  for (let i = 0; i < candles.length; i++) {
    const current = volume[i];
    if (current != null) {
      sum += current;
      validCount++;
    }
    if (i >= period) {
      const expired = volume[i - period];
      if (expired != null) {
        sum -= expired;
        validCount--;
      }
    }
    if (i >= period - 1 && validCount === period) {
      const average = sum / period;
      volumeAverage[i] = average;
      volumeRatio[i] = average > 0 && current != null ? current / average : null;
    }
  }
  return { volume, volumeAverage, volumeRatio };
}

/**
 * Highest high and lowest low of the preceding N bars.  The current bar is
 * deliberately excluded so `close > previousHigh` is a genuine breakout
 * without look-ahead or a self-referential threshold.
 */
export function calculateHighLowBreakout(
  candles: Candle[],
  params: StrategySignalParams,
): HighLowBreakoutResult {
  const previousHigh: (number | null)[] = new Array(candles.length).fill(null);
  const previousLow: (number | null)[] = new Array(candles.length).fill(null);
  const { period } = params;
  if (period < 1) return { previousHigh, previousLow };

  for (let i = period; i < candles.length; i++) {
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let j = i - period; j < i; j++) {
      high = Math.max(high, candles[j].high);
      low = Math.min(low, candles[j].low);
    }
    previousHigh[i] = Number.isFinite(high) ? high : null;
    previousLow[i] = Number.isFinite(low) ? low : null;
  }
  return { previousHigh, previousLow };
}

/**
 * Rolling close-price peak and drawdown as a positive decimal fraction.
 * For example, 0.08 represents an 8% decline from the rolling peak.
 */
export function calculateDrawdown(
  candles: Candle[],
  params: StrategySignalParams,
): DrawdownResult {
  const peak: (number | null)[] = new Array(candles.length).fill(null);
  const drawdown: (number | null)[] = new Array(candles.length).fill(null);
  const { period } = params;
  if (period < 1) return { peak, drawdown };

  for (let i = period - 1; i < candles.length; i++) {
    let rollingPeak = Number.NEGATIVE_INFINITY;
    for (let j = i - period + 1; j <= i; j++) {
      rollingPeak = Math.max(rollingPeak, candles[j].close);
    }
    if (Number.isFinite(rollingPeak) && rollingPeak > 0) {
      peak[i] = rollingPeak;
      drawdown[i] = Math.max(0, (rollingPeak - candles[i].close) / rollingPeak);
    }
  }
  return { peak, drawdown };
}
