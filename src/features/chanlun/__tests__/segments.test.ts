import { describe, expect, it } from 'vitest';
import {
  buildSegments,
  buildStandardFeatureSequence,
  findFeatureFractals,
} from '..';
import type { ChanPen } from '..';

function pensFromPrices(prices: number[]): ChanPen[] {
  return prices.slice(0, -1).map((price, index) => {
    const next = prices[index + 1];
    const direction = next > price ? 'up' : 'down';
    return {
      id: `pen-${index}`,
      direction,
      startFractalId: `f-${index}`,
      endFractalId: `f-${index + 1}`,
      startType: direction === 'up' ? 'bottom' : 'top',
      endType: direction === 'up' ? 'top' : 'bottom',
      startSourceIndex: index * 4,
      endSourceIndex: (index + 1) * 4,
      startTime: `2026-02-${String(index * 2 + 1).padStart(2, '0')}`,
      endTime: `2026-02-${String(index * 2 + 3).padStart(2, '0')}`,
      startPrice: price,
      endPrice: next,
      status: 'confirmed',
      confirmedAtIndex: (index + 1) * 4 + 2,
      confirmedAt: `2026-03-${String(index + 1).padStart(2, '0')}`,
    };
  });
}

describe('standard feature sequence', () => {
  it('selects opposite pens and resolves containment in segment direction', () => {
    const pens = pensFromPrices([0, 10, 5, 9, 6, 11, 7]);
    const sequence = buildStandardFeatureSequence(pens, 0, 'up');

    expect(sequence).toHaveLength(2);
    expect(sequence[0]).toMatchObject({
      direction: 'down',
      startPenIndex: 1,
      endPenIndex: 3,
      high: 9,
      low: 5,
      sourcePenIds: ['pen-1', 'pen-3'],
    });
  });

  it('records a no-gap top fractal as an upward segment boundary', () => {
    const pens = pensFromPrices([0, 10, 5, 12, 8, 11, 6]);
    const sequence = buildStandardFeatureSequence(pens, 0, 'up');
    const fractals = findFeatureFractals(sequence, 'up');

    expect(fractals).toHaveLength(1);
    expect(fractals[0]).toMatchObject({
      type: 'top',
      gapBetweenFirstSecond: false,
      boundaryPenIndex: 3,
      endpointPrice: 12,
      evidenceEndPenIndex: 5,
    });
  });
});

describe('standard segments', () => {
  it('confirms a first-kind no-gap boundary and leaves the last segment candidate', () => {
    const pens = pensFromPrices([0, 10, 5, 12, 8, 11, 6]);
    const segments = buildSegments(pens);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      direction: 'up',
      startPenIndex: 0,
      endPenIndex: 2,
      endPrice: 12,
      status: 'confirmed',
      confirmationKind: 'no-gap',
      confirmedAt: pens[5].confirmedAt,
    });
    expect(segments[1]).toMatchObject({
      direction: 'down',
      startPenIndex: 3,
      status: 'candidate',
      confirmationKind: null,
    });
  });

  it('requires a reverse feature fractal for a second-kind gap boundary', () => {
    const pens = pensFromPrices([0, 6, 2, 12, 8, 10, 5, 9, 6, 11]);
    const segments = buildSegments(pens);

    expect(segments[0]).toMatchObject({
      direction: 'up',
      endPrice: 12,
      status: 'confirmed',
      confirmationKind: 'gap-reversal',
      confirmedAt: pens[8].confirmedAt,
    });
    expect(segments[0].evidenceFractal?.gapBetweenFirstSecond).toBe(true);
  });

  it('does not confirm a segment when the evidence pen is still candidate', () => {
    const pens = pensFromPrices([0, 10, 5, 12, 8, 11, 6]);
    pens[5] = { ...pens[5], status: 'candidate', confirmedAt: null, confirmedAtIndex: null };

    expect(buildSegments(pens)).toEqual([
      expect.objectContaining({ status: 'candidate', direction: 'up' }),
    ]);
  });

  it('keeps an already confirmed segment stable after appending pens', () => {
    const prefix = pensFromPrices([0, 10, 5, 12, 8, 11, 6]);
    const extended = pensFromPrices([0, 10, 5, 12, 8, 11, 6, 9, 4, 8]);
    const confirmed = buildSegments(prefix).filter((segment) => segment.status === 'confirmed');
    const full = buildSegments(extended);

    for (const segment of confirmed) {
      expect(full.find((candidate) => candidate.id === segment.id)).toEqual(segment);
    }
  });
});
