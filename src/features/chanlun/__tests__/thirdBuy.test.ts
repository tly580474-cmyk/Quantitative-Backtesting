import { describe, expect, it } from 'vitest';
import type { Candle } from '@/models';
import { CHAN_V1_CONFIG, generateChanThirdBuySignals } from '..';
import type { ChanAnalysis, ChanCenter, ChanPen } from '..';

const bars: Candle[] = Array.from({ length: 16 }, (_, index) => ({
  time: `2026-06-${String(index + 1).padStart(2, '0')}`,
  symbol: 'TEST',
  open: 10,
  high: 11,
  low: 9,
  close: 10,
}));

function pen(
  id: string,
  direction: 'up' | 'down',
  startPrice: number,
  endPrice: number,
  confirmedAtIndex: number,
): ChanPen {
  return {
    id,
    direction,
    startFractalId: `${id}:start`,
    endFractalId: `${id}:end`,
    startType: direction === 'up' ? 'bottom' : 'top',
    endType: direction === 'up' ? 'top' : 'bottom',
    startSourceIndex: Math.max(0, confirmedAtIndex - 3),
    endSourceIndex: Math.max(1, confirmedAtIndex - 1),
    startTime: bars[Math.max(0, confirmedAtIndex - 3)].time,
    endTime: bars[Math.max(1, confirmedAtIndex - 1)].time,
    startPrice,
    endPrice,
    status: 'confirmed',
    confirmedAtIndex,
    confirmedAt: bars[confirmedAtIndex].time,
  };
}

const pens: ChanPen[] = [
  pen('p0', 'up', 8, 12, 3),
  pen('p1', 'down', 12, 9, 5),
  pen('p2', 'up', 9, 11, 7),
  pen('p3', 'down', 13, 11, 9),
  pen('p4', 'up', 11, 15, 11),
  pen('p5', 'down', 15, 12.2, 13),
];

const center: ChanCenter = {
  id: 'pen-center:test',
  level: 'pen',
  startComponentIndex: 0,
  endComponentIndex: 4,
  startSourceIndex: 0,
  endSourceIndex: 10,
  startTime: bars[0].time,
  endTime: bars[10].time,
  zd: 9.5,
  zg: 11,
  gg: 13,
  dd: 8,
  status: 'confirmed',
  lifecycle: 'completed',
  expanded: false,
  componentIds: ['p0', 'p1', 'p2', 'p3', 'p4'],
  extensionCount: 2,
  breakoutDirection: 'up',
  confirmedAtIndex: 7,
  confirmedAt: bars[7].time,
  completedAtIndex: 13,
  completedAt: bars[13].time,
};

function analysis(overrides: Partial<ChanAnalysis> = {}): ChanAnalysis {
  return {
    config: CHAN_V1_CONFIG,
    fingerprint: { fingerprint: 'test', dataChecksum: 'data', configHash: 'config' },
    sourceBars: bars,
    mergedBars: [],
    fractals: [],
    pens,
    segments: [],
    penCenters: [center],
    segmentCenters: [],
    current: {
      currentPenId: pens[pens.length - 1]?.id ?? null,
      currentSegmentId: null,
      latestPenCenterId: center.id,
      latestSegmentCenterId: null,
      asOfIndex: bars.length - 1,
      asOf: bars[bars.length - 1]?.time ?? null,
    },
    warnings: [],
    ...overrides,
  };
}

describe('strict Chan third-buy signals', () => {
  it('confirms only after the first downward retest remains above ZG', () => {
    expect(generateChanThirdBuySignals(analysis())).toEqual([
      expect.objectContaining({
        centerId: center.id,
        signalAtIndex: 13,
        time: bars[13].time,
        retestLow: 12.2,
        retestBufferPct: (12.2 / 11 - 1) * 100,
      }),
    ]);
  });

  it('rejects a retest that touches or re-enters the center', () => {
    const reentered = pens.map((item) => item.id === 'p5'
      ? { ...item, endPrice: center.zg }
      : item);
    expect(generateChanThirdBuySignals(analysis({ pens: reentered }))).toEqual([]);
  });

  it('rejects an unconfirmed retest so candidate structure cannot leak', () => {
    const candidate = pens.map((item) => item.id === 'p5'
      ? { ...item, status: 'candidate' as const, confirmedAtIndex: null, confirmedAt: null }
      : item);
    expect(generateChanThirdBuySignals(analysis({ pens: candidate }))).toEqual([]);
  });
});
