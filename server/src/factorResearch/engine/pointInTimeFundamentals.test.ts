import { describe, expect, it } from 'vitest';
import {
  buildPointInTimeFundamentalCte,
  crossSectionPreprocessSql,
  requiresPointInTimeFundamentals,
  selectPointInTimeFundamental,
} from './pointInTimeFundamentals.js';

describe('point-in-time fundamental feature SQL', () => {
  it('never selects a report announced after the signal date and preserves audit fields', () => {
    const sql = buildPointInTimeFundamentalCte('D:\\snapshot\\financial_reports\\data.parquet');
    expect(sql).toContain('f.announcementDate <= b.tradeDate');
    expect(sql).toContain('financialReportPeriod');
    expect(sql).toContain('financialAnnouncementDate');
    expect(sql).toContain('financialSourceVersion');
    expect(sql).toContain('ORDER BY f.announcementDate DESC');
  });

  it('recognises new terminals while leaving price-only ASTs independent', () => {
    expect(requiresPointInTimeFundamentals(['close', 'roe'])).toBe(true);
    expect(requiresPointInTimeFundamentals(['close', 'amount'])).toBe(false);
  });

  it('uses the required one and ninety-nine percent cross-sectional clipping', () => {
    const sql = crossSectionPreprocessSql('factorValue');
    expect(sql).toContain('0.01');
    expect(sql).toContain('0.99');
    expect(sql).toContain('STDDEV_SAMP');
  });

  it('does not leak an unannounced report or a future correction into an earlier decision', () => {
    const versions = [
      { reportPeriod: '2025-12-31', announcementDate: '2026-03-20', sourceVersion: 'v1', values: { roe: 8 } },
      { reportPeriod: '2025-12-31', announcementDate: '2026-04-18', sourceVersion: 'v2', updateFlag: 1, values: { roe: 12 } },
      { reportPeriod: '2026-03-31', announcementDate: '2026-04-30', sourceVersion: 'q1', values: { roe: 10 } },
    ];
    expect(selectPointInTimeFundamental(versions, '2026-03-19', 400)).toBeNull();
    expect(selectPointInTimeFundamental(versions, '2026-04-10', 400)?.values.roe).toBe(8);
    expect(selectPointInTimeFundamental(versions, '2026-04-20', 400)?.values.roe).toBe(12);
    expect(selectPointInTimeFundamental(versions, '2026-05-01', 400)?.values.roe).toBe(10);
  });

  it('treats reports beyond the declared maximum staleness as missing', () => {
    const versions = [
      { reportPeriod: '2024-12-31', announcementDate: '2025-03-20', sourceVersion: 'v1', values: { roe: 8 } },
    ];
    expect(selectPointInTimeFundamental(versions, '2026-03-21', 365)).toBeNull();
  });
});
