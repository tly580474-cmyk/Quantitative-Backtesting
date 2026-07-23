import type {
  ChanDirection,
  ChanFeatureElement,
  ChanFeatureFractal,
  ChanPen,
} from './types';

function overlaps(a: Pick<ChanFeatureElement, 'high' | 'low'>, b: Pick<ChanFeatureElement, 'high' | 'low'>): boolean {
  return Math.max(a.low, b.low) <= Math.min(a.high, b.high);
}

function contains(a: ChanFeatureElement, b: ChanFeatureElement): boolean {
  return (a.high >= b.high && a.low <= b.low)
    || (b.high >= a.high && b.low <= a.low);
}

function fromPen(pen: ChanPen, penIndex: number): ChanFeatureElement {
  const highAtStart = pen.startPrice >= pen.endPrice;
  return {
    id: `feature:${pen.id}`,
    direction: pen.direction,
    startPenIndex: penIndex,
    endPenIndex: penIndex,
    high: Math.max(pen.startPrice, pen.endPrice),
    low: Math.min(pen.startPrice, pen.endPrice),
    highSourceIndex: highAtStart ? pen.startSourceIndex : pen.endSourceIndex,
    lowSourceIndex: highAtStart ? pen.endSourceIndex : pen.startSourceIndex,
    highSourceTime: highAtStart ? pen.startTime : pen.endTime,
    lowSourceTime: highAtStart ? pen.endTime : pen.startTime,
    highSourcePenIndex: penIndex,
    lowSourcePenIndex: penIndex,
    sourcePenIds: [pen.id],
    gapFromPrevious: false,
  };
}

function mergeFeatureElements(
  previous: ChanFeatureElement,
  incoming: ChanFeatureElement,
  segmentDirection: ChanDirection,
): ChanFeatureElement {
  const upward = segmentDirection === 'down';
  const high = upward ? Math.max(previous.high, incoming.high) : Math.min(previous.high, incoming.high);
  const low = upward ? Math.max(previous.low, incoming.low) : Math.min(previous.low, incoming.low);
  const incomingOwnsHigh = high !== previous.high;
  const incomingOwnsLow = low !== previous.low;
  return {
    ...previous,
    id: `${previous.id}+${incoming.id}`,
    endPenIndex: incoming.endPenIndex,
    high,
    low,
    highSourceIndex: incomingOwnsHigh ? incoming.highSourceIndex : previous.highSourceIndex,
    lowSourceIndex: incomingOwnsLow ? incoming.lowSourceIndex : previous.lowSourceIndex,
    highSourceTime: incomingOwnsHigh ? incoming.highSourceTime : previous.highSourceTime,
    lowSourceTime: incomingOwnsLow ? incoming.lowSourceTime : previous.lowSourceTime,
    highSourcePenIndex: incomingOwnsHigh ? incoming.highSourcePenIndex : previous.highSourcePenIndex,
    lowSourcePenIndex: incomingOwnsLow ? incoming.lowSourcePenIndex : previous.lowSourcePenIndex,
    sourcePenIds: [...previous.sourcePenIds, ...incoming.sourcePenIds],
  };
}

export function buildStandardFeatureSequence(
  pens: readonly ChanPen[],
  segmentStartPenIndex: number,
  segmentDirection: ChanDirection,
): ChanFeatureElement[] {
  const featureDirection: ChanDirection = segmentDirection === 'up' ? 'down' : 'up';
  const result: ChanFeatureElement[] = [];
  for (let index = segmentStartPenIndex; index < pens.length; index += 1) {
    const pen = pens[index];
    if (pen.direction !== featureDirection) continue;
    const incoming = fromPen(pen, index);
    const previous = result[result.length - 1];
    if (previous && contains(previous, incoming)) {
      result[result.length - 1] = mergeFeatureElements(previous, incoming, segmentDirection);
    } else {
      result.push(incoming);
    }
  }
  return result.map((element, index) => ({
    ...element,
    gapFromPrevious: index > 0 && !overlaps(result[index - 1], element),
  }));
}

export function findFeatureFractals(
  elements: readonly ChanFeatureElement[],
  segmentDirection: ChanDirection,
): ChanFeatureFractal[] {
  const targetType = segmentDirection === 'up' ? 'top' : 'bottom';
  const result: ChanFeatureFractal[] = [];
  for (let index = 1; index < elements.length - 1; index += 1) {
    const left = elements[index - 1];
    const center = elements[index];
    const right = elements[index + 1];
    const top = center.high > left.high && center.high > right.high
      && center.low > left.low && center.low > right.low;
    const bottom = center.high < left.high && center.high < right.high
      && center.low < left.low && center.low < right.low;
    if ((targetType === 'top' && !top) || (targetType === 'bottom' && !bottom)) continue;
    const useHigh = targetType === 'top';
    result.push({
      type: targetType,
      leftElementId: left.id,
      centerElementId: center.id,
      rightElementId: right.id,
      gapBetweenFirstSecond: !overlaps(left, center),
      boundaryPenIndex: useHigh ? center.highSourcePenIndex : center.lowSourcePenIndex,
      endpointSourceIndex: useHigh ? center.highSourceIndex : center.lowSourceIndex,
      endpointTime: useHigh ? center.highSourceTime : center.lowSourceTime,
      endpointPrice: useHigh ? center.high : center.low,
      evidenceEndPenIndex: right.endPenIndex,
    });
  }
  return result;
}

