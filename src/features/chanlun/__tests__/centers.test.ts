import { describe, expect, it } from 'vitest';
import { buildCenters } from '..';
import type { ChanPen, ChanSegment } from '..';

function penRanges(ranges: Array<[number, number]>, candidateIndex = -1): ChanPen[] {
  return ranges.map(([low, high], index) => {
    const candidate = index === candidateIndex;
    const direction = index % 2 === 0 ? 'up' : 'down';
    return {
      id: `pen-${index}`,
      direction,
      startFractalId: `f-${index}`,
      endFractalId: `f-${index + 1}`,
      startType: direction === 'up' ? 'bottom' : 'top',
      endType: direction === 'up' ? 'top' : 'bottom',
      startSourceIndex: index * 4,
      endSourceIndex: index * 4 + 3,
      startTime: `2026-04-${String(index * 2 + 1).padStart(2, '0')}`,
      endTime: `2026-04-${String(index * 2 + 2).padStart(2, '0')}`,
      startPrice: direction === 'up' ? low : high,
      endPrice: direction === 'up' ? high : low,
      status: candidate ? 'candidate' : 'confirmed',
      confirmedAtIndex: candidate ? null : index * 4 + 5,
      confirmedAt: candidate ? null : `2026-05-${String(index + 1).padStart(2, '0')}`,
    };
  });
}

function asSegments(pens: ChanPen[]): ChanSegment[] {
  return pens.map((pen, index) => ({
    id: `segment-${index}`,
    direction: pen.direction,
    startPenIndex: index * 3,
    endPenIndex: index * 3 + 2,
    startSourceIndex: pen.startSourceIndex,
    endSourceIndex: pen.endSourceIndex,
    startTime: pen.startTime,
    endTime: pen.endTime,
    startPrice: pen.startPrice,
    endPrice: pen.endPrice,
    status: pen.status,
    confirmationKind: pen.status === 'confirmed' ? 'no-gap' : null,
    confirmedAtIndex: pen.confirmedAtIndex,
    confirmedAt: pen.confirmedAt,
    featureElements: [],
    evidenceFractal: null,
  }));
}

describe('standard centers', () => {
  it('forms a confirmed center from three consecutive overlapping components', () => {
    const centers = buildCenters(penRanges([[0, 10], [4, 12], [6, 11]]), 'pen');

    expect(centers).toHaveLength(1);
    expect(centers[0]).toMatchObject({
      level: 'pen',
      zd: 6,
      zg: 10,
      gg: 12,
      dd: 0,
      status: 'confirmed',
      lifecycle: 'active',
      extensionCount: 0,
    });
  });

  it('extends against a fixed core and completes only on a confirmed departure', () => {
    const ranges: Array<[number, number]> = [
      [0, 10], [4, 12], [6, 11], [7, 13], [11, 14],
    ];
    const center = buildCenters(penRanges(ranges), 'pen')[0];

    expect(center).toMatchObject({
      zd: 6,
      zg: 10,
      gg: 13,
      dd: 0,
      endComponentIndex: 3,
      extensionCount: 1,
      lifecycle: 'completed',
      breakoutDirection: 'up',
      completedAt: '2026-05-05',
    });
  });

  it('keeps formation and departure tentative when their evidence is candidate', () => {
    const forming = buildCenters(penRanges([[0, 10], [4, 12], [6, 11]], 2), 'pen')[0];
    expect(forming).toMatchObject({
      status: 'candidate',
      lifecycle: 'forming',
      confirmedAt: null,
    });

    const active = buildCenters(
      penRanges([[0, 10], [4, 12], [6, 11], [11, 14]], 3),
      'pen',
    )[0];
    expect(active).toMatchObject({
      status: 'confirmed',
      lifecycle: 'active',
      breakoutDirection: null,
      completedAt: null,
    });
  });

  it('marks a nine-component extension as expansion', () => {
    const ranges = Array.from({ length: 9 }, (_, index) => [index % 3, 10 + index % 2] as [number, number]);
    const center = buildCenters(penRanges(ranges), 'pen')[0];

    expect(center).toMatchObject({ expanded: true, extensionCount: 6 });
    expect(center.componentIds).toHaveLength(9);
  });

  it('uses the same formal algorithm for segment-level centers', () => {
    const segments = asSegments(penRanges([[0, 10], [4, 12], [6, 11]]));
    const center = buildCenters(segments, 'segment')[0];

    expect(center).toMatchObject({ level: 'segment', zd: 6, zg: 10 });
    expect(center.componentIds).toEqual(['segment-0', 'segment-1', 'segment-2']);
  });

  it('keeps a completed center stable after later structures arrive', () => {
    const prefix = penRanges([[0, 10], [4, 12], [6, 11], [7, 13], [11, 14]]);
    const extended = penRanges([
      [0, 10], [4, 12], [6, 11], [7, 13], [11, 14], [12, 16], [13, 15], [12, 14],
    ]);
    const completed = buildCenters(prefix, 'pen')[0];
    const full = buildCenters(extended, 'pen');

    expect(full.find((center) => center.id === completed.id)).toEqual(completed);
  });
});
