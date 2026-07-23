import type { Candle } from '@/models';
import type { ChanBar, ChanDirection } from './types';

function contains(a: Pick<ChanBar, 'high' | 'low'>, b: Pick<Candle, 'high' | 'low'>): boolean {
  return (a.high >= b.high && a.low <= b.low)
    || (b.high >= a.high && b.low <= a.low);
}

function relation(a: Pick<ChanBar, 'high' | 'low'>, b: Pick<Candle, 'high' | 'low'>): ChanDirection {
  return b.high > a.high && b.low > a.low ? 'up' : 'down';
}

function makeBar(candle: Candle, sourceIndex: number, direction: ChanBar['direction']): ChanBar {
  return {
    index: 0,
    startIndex: sourceIndex,
    endIndex: sourceIndex,
    startTime: candle.time,
    endTime: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    direction,
    sourceIndices: [sourceIndex],
    highSourceIndex: sourceIndex,
    lowSourceIndex: sourceIndex,
    highSourceTime: candle.time,
    lowSourceTime: candle.time,
  };
}

function bootstrapDirection(last: ChanBar, incoming: Candle): ChanDirection {
  if (last.direction !== 'unknown') return last.direction;
  return incoming.close >= last.close ? 'up' : 'down';
}

function mergeContained(last: ChanBar, incoming: Candle, sourceIndex: number): ChanBar {
  const direction = bootstrapDirection(last, incoming);
  const high = direction === 'up' ? Math.max(last.high, incoming.high) : Math.min(last.high, incoming.high);
  const low = direction === 'up' ? Math.max(last.low, incoming.low) : Math.min(last.low, incoming.low);
  const incomingOwnsHigh = high !== last.high;
  const incomingOwnsLow = low !== last.low;

  return {
    ...last,
    endIndex: sourceIndex,
    endTime: incoming.time,
    high,
    low,
    close: incoming.close,
    volume: last.volume == null && incoming.volume == null
      ? undefined
      : (last.volume ?? 0) + (incoming.volume ?? 0),
    direction,
    sourceIndices: [...last.sourceIndices, sourceIndex],
    highSourceIndex: incomingOwnsHigh ? sourceIndex : last.highSourceIndex,
    lowSourceIndex: incomingOwnsLow ? sourceIndex : last.lowSourceIndex,
    highSourceTime: incomingOwnsHigh ? incoming.time : last.highSourceTime,
    lowSourceTime: incomingOwnsLow ? incoming.time : last.lowSourceTime,
  };
}

export function resolveContainment(candles: readonly Candle[]): ChanBar[] {
  const result: ChanBar[] = [];

  candles.forEach((candle, sourceIndex) => {
    if (result.length === 0) {
      result.push(makeBar(candle, sourceIndex, 'unknown'));
      return;
    }

    const last = result[result.length - 1];
    if (contains(last, candle)) {
      result[result.length - 1] = mergeContained(last, candle, sourceIndex);
      return;
    }

    const direction = relation(last, candle);
    last.direction = direction;
    result.push(makeBar(candle, sourceIndex, direction));
  });

  return result.map((bar, index) => ({ ...bar, index }));
}

