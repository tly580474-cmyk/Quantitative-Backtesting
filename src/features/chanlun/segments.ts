import { buildStandardFeatureSequence, findFeatureFractals } from './featureSequence';
import type {
  ChanDirection,
  ChanFeatureFractal,
  ChanPen,
  ChanSegment,
} from './types';

interface SegmentBoundary {
  fractal: ChanFeatureFractal;
  kind: 'no-gap' | 'gap-reversal';
  confirmedAtIndex: number;
  confirmedAt: string;
}

function firstThreePensOverlap(pens: readonly ChanPen[], start: number): boolean {
  if (start + 2 >= pens.length) return false;
  const first = pens.slice(start, start + 3);
  const lows = first.map((pen) => Math.min(pen.startPrice, pen.endPrice));
  const highs = first.map((pen) => Math.max(pen.startPrice, pen.endPrice));
  return Math.max(...lows) <= Math.min(...highs);
}

function confirmedByEvidence(pens: readonly ChanPen[], penIndex: number): ChanPen | null {
  const pen = pens[penIndex];
  return pen?.status === 'confirmed' && pen.confirmedAtIndex != null && pen.confirmedAt != null
    ? pen
    : null;
}

function endpointSurvives(
  pens: readonly ChanPen[],
  boundary: ChanFeatureFractal,
  evidenceEndPenIndex: number,
  direction: ChanDirection,
): boolean {
  const relevant = pens.slice(boundary.boundaryPenIndex, evidenceEndPenIndex + 1);
  return direction === 'up'
    ? relevant.every((pen) => Math.max(pen.startPrice, pen.endPrice) <= boundary.endpointPrice)
    : relevant.every((pen) => Math.min(pen.startPrice, pen.endPrice) >= boundary.endpointPrice);
}

function findBoundary(
  pens: readonly ChanPen[],
  startPenIndex: number,
  direction: ChanDirection,
): SegmentBoundary | null {
  const elements = buildStandardFeatureSequence(pens, startPenIndex, direction);
  for (const fractal of findFeatureFractals(elements, direction)) {
    if (!fractal.gapBetweenFirstSecond) {
      const evidence = confirmedByEvidence(pens, fractal.evidenceEndPenIndex);
      if (evidence) {
        return {
          fractal,
          kind: 'no-gap',
          confirmedAtIndex: evidence.confirmedAtIndex!,
          confirmedAt: evidence.confirmedAt!,
        };
      }
      continue;
    }

    const reverseDirection: ChanDirection = direction === 'up' ? 'down' : 'up';
    const reverseElements = buildStandardFeatureSequence(pens, fractal.boundaryPenIndex, reverseDirection);
    const reverseFractal = findFeatureFractals(reverseElements, reverseDirection)[0];
    if (!reverseFractal) continue;
    const evidence = confirmedByEvidence(pens, reverseFractal.evidenceEndPenIndex);
    if (!evidence) continue;
    if (!endpointSurvives(pens, fractal, reverseFractal.evidenceEndPenIndex, direction)) continue;
    return {
      fractal,
      kind: 'gap-reversal',
      confirmedAtIndex: evidence.confirmedAtIndex!,
      confirmedAt: evidence.confirmedAt!,
    };
  }
  return null;
}

function makeConfirmedSegment(
  pens: readonly ChanPen[],
  startPenIndex: number,
  direction: ChanDirection,
  boundary: SegmentBoundary,
): ChanSegment {
  const start = pens[startPenIndex];
  const endPenIndex = boundary.fractal.boundaryPenIndex - 1;
  return {
    id: `segment:${start.startSourceIndex}->${boundary.fractal.endpointSourceIndex}`,
    direction,
    startPenIndex,
    endPenIndex,
    startSourceIndex: start.startSourceIndex,
    endSourceIndex: boundary.fractal.endpointSourceIndex,
    startTime: start.startTime,
    endTime: boundary.fractal.endpointTime,
    startPrice: start.startPrice,
    endPrice: boundary.fractal.endpointPrice,
    status: 'confirmed',
    confirmationKind: boundary.kind,
    confirmedAtIndex: boundary.confirmedAtIndex,
    confirmedAt: boundary.confirmedAt,
    featureElements: buildStandardFeatureSequence(pens, startPenIndex, direction)
      .filter((element) => element.startPenIndex <= boundary.fractal.evidenceEndPenIndex),
    evidenceFractal: boundary.fractal,
  };
}

function makeCandidateSegment(
  pens: readonly ChanPen[],
  startPenIndex: number,
  direction: ChanDirection,
): ChanSegment | null {
  if (!firstThreePensOverlap(pens, startPenIndex)) return null;
  const relevant = pens.slice(startPenIndex);
  let endpoint = direction === 'up'
    ? relevant.reduce((best, pen) => pen.endPrice > best.endPrice ? pen : best)
    : relevant.reduce((best, pen) => pen.endPrice < best.endPrice ? pen : best);
  if (direction === 'up' && endpoint.endPrice <= pens[startPenIndex].startPrice) endpoint = relevant[relevant.length - 1];
  if (direction === 'down' && endpoint.endPrice >= pens[startPenIndex].startPrice) endpoint = relevant[relevant.length - 1];
  const start = pens[startPenIndex];
  return {
    id: `segment:${start.startSourceIndex}->${endpoint.endSourceIndex}`,
    direction,
    startPenIndex,
    endPenIndex: pens.indexOf(endpoint),
    startSourceIndex: start.startSourceIndex,
    endSourceIndex: endpoint.endSourceIndex,
    startTime: start.startTime,
    endTime: endpoint.endTime,
    startPrice: start.startPrice,
    endPrice: endpoint.endPrice,
    status: 'candidate',
    confirmationKind: null,
    confirmedAtIndex: null,
    confirmedAt: null,
    featureElements: buildStandardFeatureSequence(pens, startPenIndex, direction),
    evidenceFractal: null,
  };
}

export function buildSegments(pens: readonly ChanPen[]): ChanSegment[] {
  if (pens.length < 3) return [];
  const segments: ChanSegment[] = [];
  let startPenIndex = 0;
  // A finite data window may begin in the middle of an older segment. Skip the
  // unstable warm-up pens until the first locally valid three-pen overlap.
  while (startPenIndex + 2 < pens.length && !firstThreePensOverlap(pens, startPenIndex)) {
    startPenIndex += 1;
  }
  if (startPenIndex + 2 >= pens.length) return [];
  let direction = pens[startPenIndex].direction;
  while (firstThreePensOverlap(pens, startPenIndex)) {
    const boundary = findBoundary(pens, startPenIndex, direction);
    if (!boundary || boundary.fractal.boundaryPenIndex <= startPenIndex) break;
    segments.push(makeConfirmedSegment(pens, startPenIndex, direction, boundary));
    startPenIndex = boundary.fractal.boundaryPenIndex;
    direction = direction === 'up' ? 'down' : 'up';
  }
  const candidate = makeCandidateSegment(pens, startPenIndex, direction);
  if (candidate) segments.push(candidate);
  return segments;
}
