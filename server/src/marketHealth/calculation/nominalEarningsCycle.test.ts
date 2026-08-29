import { describe, expect, it } from 'vitest';
import {
  calculateLatestNominalEarningsCycle,
  calculateNominalEarningsCycleSeries,
} from './nominalEarningsCycle.js';
import type { StoredMacroObservation } from '../macroRepository.js';

function observations(values: number[]): StoredMacroObservation[] {
  return values.map((value, index) => {
    const date = new Date(Date.UTC(2020, index, 1));
    const period = date.toISOString().slice(0, 10);
    return {
      id: index + 1,
      seriesKey: 'ppi_yoy',
      observationPeriod: period,
      value,
      publishedAt: null,
      availableAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 15)).toISOString(),
      fetchedAt: '2026-08-29T00:00:00.000Z',
      sourceKey: 'akshare-eastmoney',
      authorityKey: 'nbs',
      sourceUrl: null,
      sourceChecksum: `hash-${index}`,
      revisionNo: 1,
      status: 'observed',
    };
  });
}

describe('nominal earnings cycle', () => {
  it('requires a causal history window', () => {
    expect(calculateLatestNominalEarningsCycle(observations(Array(39).fill(1)))).toBeNull();
  });

  it('uses only prior observations for normalization', () => {
    const values = Array.from({ length: 64 }, (_, index) => -4 + index * 0.1);
    const result = calculateLatestNominalEarningsCycle(observations(values), new Date('2026-08-29T00:00:00Z'));
    expect(result).not.toBeNull();
    expect(result!.indicatorKey).toBe('nec');
    expect(result!.score).toBeGreaterThan(50);
    expect(result!.components.map((item) => item.weight)).toEqual([0.6, 0.4]);
  });

  it('constructs one causal snapshot per eligible observation month', () => {
    const result = calculateNominalEarningsCycleSeries(observations(Array.from({ length: 64 }, (_, index) => index * 0.1)));
    expect(result).toHaveLength(25);
    expect(result[0].periodKey).toBe('2023-04');
    expect(result.at(-1)?.periodKey).toBe('2025-04');
  });
});
