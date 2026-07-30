import { describe, expect, it } from 'vitest';
import {
  buildPointInTimeFundamentalCte,
  crossSectionPreprocessSql,
  requiresPointInTimeFundamentals,
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
});
