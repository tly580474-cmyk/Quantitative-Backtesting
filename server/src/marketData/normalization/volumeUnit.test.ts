import { describe, expect, it } from 'vitest';
import {
  markVolumeUnitCorrection,
  normalizeVolumeToShares,
} from './volumeUnit.js';

const prices = { open: 15, high: 15.5, low: 14.8, close: 15.18 };

describe('volume unit normalization', () => {
  it('keeps canonical share volume', () => {
    expect(normalizeVolumeToShares({
      ...prices,
      volume: 7_000_000,
      amount: 106_350_000,
    })).toMatchObject({ volume: 7_000_000, correction: null, factor: 1 });
  });

  it('divides a volume that was multiplied by 100 twice', () => {
    expect(normalizeVolumeToShares({
      ...prices,
      volume: 691_464_600,
      amount: 106_350_000,
    })).toMatchObject({
      volume: 6_914_646,
      correction: 'divide-by-100',
      factor: 0.01,
    });
  });

  it('converts lots to shares', () => {
    expect(normalizeVolumeToShares({
      open: 1.65,
      high: 1.72,
      low: 1.62,
      close: 1.68,
      volume: 579_800,
      amount: 97_410_000,
    })).toMatchObject({
      volume: 57_980_000,
      correction: 'multiply-by-100',
      factor: 100,
    });
  });

  it('does not guess when amount evidence is missing', () => {
    expect(normalizeVolumeToShares({
      ...prices,
      volume: 123_400,
      amount: null,
    })).toMatchObject({ volume: 123_400, correction: null });
  });

  it('marks corrected source versions idempotently', () => {
    expect(markVolumeUnitCorrection('1:tencent', 'divide-by-100'))
      .toBe('1:tencent:vol/100');
    expect(markVolumeUnitCorrection('1:tencent:vol/100', 'divide-by-100'))
      .toBe('1:tencent:vol/100');
  });
});
