import { describe, expect, it } from 'vitest';
import { assertManagedParquetAccess, assertTemporalCoverage } from './researchQueryGuard.js';
import type { ResearchSnapshotManifest } from './snapshotManifest.js';

const manifest = {
  datasets: [
    { name: 'sw_industry_memberships', minDate: '2021-07-30' },
    { name: 'sw_industry_bars', minDate: '2021-01-01' },
  ],
} as ResearchSnapshotManifest;

describe('research query guards', () => {
  it('blocks unmanaged parquet globs unless explicitly authorized', () => {
    expect(() => assertManagedParquetAccess(
      "SELECT * FROM read_parquet('D:/lake/year=*/*.parquet')",
      {},
      false,
    )).toThrow(/通配符/);
    expect(() => assertManagedParquetAccess(
      "SELECT * FROM read_parquet('D:/lake/year=*/*.parquet')",
      {},
      true,
    )).not.toThrow();
    expect(() => assertManagedParquetAccess(
      'SELECT * FROM read_parquet($minuteGlob)',
      { minuteGlob: 'D:/lake/*.parquet' },
      false,
    )).toThrow(/通配符/);
  });

  it('blocks industry research before the common supported boundary', () => {
    expect(() => assertTemporalCoverage(
      'SELECT * FROM sw_industry_memberships',
      { startDate: '2020-01-01' },
      manifest,
    )).toThrow(/2021-07-30/);
    expect(() => assertTemporalCoverage(
      'SELECT * FROM sw_industry_bars',
      { startDate: '2022-01-01' },
      manifest,
    )).not.toThrow();
  });
});
