import type { Candle } from '@/models';
import type { ChanBar, ChanFractal } from './types';

export function identifyStrictFractals(
  mergedBars: readonly ChanBar[],
  sourceBars: readonly Candle[],
): ChanFractal[] {
  const fractals: ChanFractal[] = [];

  // The right bar may still absorb future contained candles. A subsequent
  // independent merged bar locks that right bar; only then is the fractal
  // eligible for confirmed structures and backtests.
  for (let i = 1; i < mergedBars.length - 2; i += 1) {
    const left = mergedBars[i - 1];
    const current = mergedBars[i];
    const right = mergedBars[i + 1];
    const isTop = current.high > left.high && current.high > right.high
      && current.low > left.low && current.low > right.low;
    const isBottom = current.high < left.high && current.high < right.high
      && current.low < left.low && current.low < right.low;
    if (!isTop && !isBottom) continue;

    const type = isTop ? 'top' : 'bottom';
    const sourceIndex = isTop ? current.highSourceIndex : current.lowSourceIndex;
    const lock = mergedBars[i + 2];
    const confirmedAtIndex = lock.startIndex;
    fractals.push({
      id: `${type}:${sourceIndex}:${sourceBars[sourceIndex].time}`,
      type,
      mergedIndex: i,
      sourceIndex,
      time: sourceBars[sourceIndex].time,
      price: isTop ? current.high : current.low,
      leftMergedIndex: i - 1,
      rightMergedIndex: i + 1,
      status: 'confirmed',
      confirmedAtIndex,
      confirmedAt: sourceBars[confirmedAtIndex].time,
    });
  }

  return fractals;
}
