import { describe, expect, it } from 'vitest';
import type { Candle } from '@/models';
import {
  analyzeChanlun,
  IncrementalChanEngine,
  resolveContainment,
} from '..';
import { GOLDEN_CHAN_BARS } from './fixtures';

function candle(time: string, high: number, low: number, close = (high + low) / 2): Candle {
  return { time, symbol: 'TEST', open: close, high, low, close, volume: 10 };
}

describe('chan-v1 containment', () => {
  it('merges containment upward and preserves source provenance', () => {
    const bars = resolveContainment([
      candle('2026-01-01', 10, 5, 7),
      candle('2026-01-02', 12, 7, 10),
      candle('2026-01-03', 11, 8, 10),
    ]);

    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({
      high: 12,
      low: 8,
      direction: 'up',
      sourceIndices: [1, 2],
      highSourceIndex: 1,
      lowSourceIndex: 2,
    });
  });
});

describe('chan-v1 structure engine', () => {
  it('finds strict fractals and keeps only the last pen candidate', () => {
    const result = analyzeChanlun(GOLDEN_CHAN_BARS.slice(0, 18));

    expect(result.fractals.map(({ type, sourceIndex }) => [type, sourceIndex])).toEqual([
      ['top', 4],
      ['bottom', 8],
      ['top', 12],
    ]);
    expect(result.pens).toHaveLength(2);
    expect(result.pens[0]).toMatchObject({
      direction: 'down',
      startSourceIndex: 4,
      endSourceIndex: 8,
      status: 'confirmed',
      confirmedAtIndex: 14,
    });
    expect(result.pens[1]).toMatchObject({
      direction: 'up',
      startSourceIndex: 8,
      endSourceIndex: 12,
      status: 'candidate',
      confirmedAtIndex: null,
    });
  });

  it('does not confirm an end fractal until a later independent merged bar locks it', () => {
    expect(analyzeChanlun(GOLDEN_CHAN_BARS.slice(0, 14)).fractals.map((item) => item.sourceIndex))
      .toEqual([4, 8]);
    expect(analyzeChanlun(GOLDEN_CHAN_BARS.slice(0, 15)).fractals.map((item) => item.sourceIndex))
      .toEqual([4, 8, 12]);
  });

  it('produces identical incremental and batch snapshots', () => {
    const incremental = new IncrementalChanEngine();
    for (const bar of GOLDEN_CHAN_BARS) incremental.append(bar);

    expect(incremental.snapshot()).toEqual(analyzeChanlun(GOLDEN_CHAN_BARS));
  });

  it('does not rewrite a pen already confirmed in an earlier prefix', () => {
    const prefix = analyzeChanlun(GOLDEN_CHAN_BARS.slice(0, 14));
    const full = analyzeChanlun(GOLDEN_CHAN_BARS);
    const prefixConfirmed = prefix.pens.filter((pen) => pen.status === 'confirmed');

    for (const pen of prefixConfirmed) {
      expect(full.pens.find((candidate) => candidate.id === pen.id)).toEqual(pen);
    }
  });

  it('rejects duplicate or unordered candle time', () => {
    expect(() => analyzeChanlun([
      GOLDEN_CHAN_BARS[1],
      GOLDEN_CHAN_BARS[0],
    ])).toThrow(/严格递增/);
  });

  it('fingerprints the same input deterministically', () => {
    const first = analyzeChanlun(GOLDEN_CHAN_BARS);
    const second = analyzeChanlun(GOLDEN_CHAN_BARS.map((bar) => ({ ...bar })));
    expect(second.fingerprint).toEqual(first.fingerprint);
  });
});
