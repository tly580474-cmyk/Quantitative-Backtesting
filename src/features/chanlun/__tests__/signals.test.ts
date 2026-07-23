import { describe, expect, it } from 'vitest';
import { CHAN_V1_CONFIG, generateChanCenterSignals } from '..';
import type { Candle } from '@/models';
import type { ChanAnalysis, ChanCenter } from '..';

const bars: Candle[] = Array.from({ length: 8 }, (_, index) => ({
  time: `2026-06-${String(index + 1).padStart(2, '0')}`,
  symbol: 'TEST',
  open: 10,
  high: 11,
  low: 9,
  close: 10,
}));

const completedCenter: ChanCenter = {
  id: 'pen-center:test',
  level: 'pen',
  startComponentIndex: 0,
  endComponentIndex: 3,
  startSourceIndex: 0,
  endSourceIndex: 5,
  startTime: bars[0].time,
  endTime: bars[5].time,
  zd: 9.5,
  zg: 10.5,
  gg: 12,
  dd: 8,
  status: 'confirmed',
  lifecycle: 'completed',
  expanded: false,
  componentIds: ['p0', 'p1', 'p2', 'p3'],
  extensionCount: 1,
  breakoutDirection: 'up',
  confirmedAtIndex: 4,
  confirmedAt: bars[4].time,
  completedAtIndex: 6,
  completedAt: bars[6].time,
};

function analysisWith(center: ChanCenter): ChanAnalysis {
  return {
    config: CHAN_V1_CONFIG,
    fingerprint: { fingerprint: 'test', dataChecksum: 'data', configHash: 'config' },
    sourceBars: bars,
    mergedBars: [],
    fractals: [],
    pens: [],
    segments: [],
    penCenters: center.level === 'pen' ? [center] : [],
    segmentCenters: center.level === 'segment' ? [center] : [],
    current: {
      currentPenId: null,
      currentSegmentId: null,
      latestPenCenterId: center.level === 'pen' ? center.id : null,
      latestSegmentCenterId: center.level === 'segment' ? center.id : null,
      asOfIndex: bars.length - 1,
      asOf: bars[bars.length - 1].time,
    },
    warnings: [],
  };
}

describe('Chan center signals', () => {
  it('emits on the recorded completion bar and targets the breakout position', () => {
    const signals = generateChanCenterSignals(analysisWith(completedCenter), 'pen');

    expect(signals).toEqual([
      expect.objectContaining({
        time: bars[6].time,
        action: 'buy',
        targetPosition: 1,
        signalAtIndex: 6,
        centerId: completedCenter.id,
      }),
    ]);
  });

  it('does not expose candidate or not-yet-completed structure evidence', () => {
    const active = {
      ...completedCenter,
      lifecycle: 'active' as const,
      breakoutDirection: null,
      completedAtIndex: null,
      completedAt: null,
    };
    const candidate = {
      ...completedCenter,
      status: 'candidate' as const,
      lifecycle: 'forming' as const,
    };

    expect(generateChanCenterSignals(analysisWith(active))).toEqual([]);
    expect(generateChanCenterSignals(analysisWith(candidate))).toEqual([]);
  });

  it('maps a confirmed downward segment-center departure to a sell signal', () => {
    const segmentCenter: ChanCenter = {
      ...completedCenter,
      id: 'segment-center:test',
      level: 'segment',
      breakoutDirection: 'down',
    };
    const signals = generateChanCenterSignals(analysisWith(segmentCenter), 'segment');

    expect(signals[0]).toMatchObject({ action: 'sell', targetPosition: 0, centerLevel: 'segment' });
  });
});
