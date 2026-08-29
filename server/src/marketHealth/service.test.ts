import { describe, expect, it } from 'vitest';
import { presentSnapshot, resolveFreshness } from './service.js';
import type { StoredMarketHealthSnapshot } from './repository.js';

function snapshot(overrides: Partial<StoredMarketHealthSnapshot> = {}): StoredMarketHealthSnapshot {
  return {
    id: 1,
    indicatorKey: 'fhi',
    asOfDate: '2026-06-30',
    periodKey: '2026Q2',
    score: 64.321,
    statusLabel: '盈利较强',
    interpretation: '已披露盈利保持韧性。',
    direction: 'higher_is_better',
    frequency: 'event',
    modelVersion: 'fhi-v1',
    components: [],
    sourcePeriods: { financialReport: '2026Q2' },
    coveragePct: 91.4,
    sourceSnapshotId: 'snapshot-1',
    calculatedAt: '2026-08-29T11:00:00.000Z',
    publicationStatus: 'published',
    staleAfter: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('market health presentation', () => {
  it('preserves axis semantics and rounds the score', () => {
    expect(presentSnapshot(snapshot(), '2026-08-29T12:00:00.000Z')).toMatchObject({
      key: 'fhi',
      name: '盈利承载',
      score: 64.32,
      direction: 'higher_is_better',
      freshness: 'current',
    });
  });

  it('marks preliminary before stale evaluation', () => {
    expect(resolveFreshness(snapshot({ publicationStatus: 'preliminary' }), '2027-01-01T00:00:00.000Z'))
      .toBe('preliminary');
  });

  it('marks an expired published snapshot stale', () => {
    expect(resolveFreshness(snapshot(), '2026-12-01T00:00:00.000Z')).toBe('stale');
  });

  it('clamps malformed persisted scores at the API boundary', () => {
    expect(presentSnapshot(snapshot({ score: 140 }), '2026-08-29T12:00:00.000Z').score).toBe(100);
  });
});
