import { expect, it } from 'vitest';
import { auditAdjustmentContinuity, type AuditBar } from './adjustmentAudit.js';

const bar = (tradeDate: string, close: number, previousClose: number | null): AuditBar =>
  ({ tradeDate, open: close, high: close, low: close, close, previousClose });
const raw = [bar('2026-07-09', 24.27, 24.89), bar('2026-07-10', 18.63, 18.48)];
it('detects a missed split even when a baseline publication exists', () => {
  const result = auditAdjustmentContinuity(raw, [{ effectiveDate: '2000-01-01', factor: 1, offset: 0 }], '2026-07-10');
  expect(result.mismatches).toHaveLength(1);
  expect(result.mismatches[0].difference).toBeCloseTo(5.79);
});
it('accepts reconstructed ex-right reference prices with exchange tick rounding', () => {
  const result = auditAdjustmentContinuity(raw, [
    { effectiveDate: '2000-01-01', factor: 1 / 1.3, offset: -0.25 / 1.3 },
    { effectiveDate: '2026-07-10', factor: 1, offset: 0 },
  ], '2026-07-10');
  expect(result.compared).toBe(1); expect(result.mismatches).toEqual([]);
});
it('does not confuse a genuine large price move with a factor discontinuity', () => {
  const result = auditAdjustmentContinuity([bar('2026-07-09', 10, 10), bar('2026-07-10', 13, 10)],
    [{ effectiveDate: '2000-01-01', factor: 1, offset: 0 }], '2026-07-10');
  expect(result.mismatches).toEqual([]);
});
it('reports missing evidence and invalid factor series instead of passing them', () => {
  expect(auditAdjustmentContinuity(raw, [], '2026-07-10').structural).toContain('missing_factors');
  expect(auditAdjustmentContinuity([bar('2026-07-10', 10, null)],
    [{ effectiveDate: '2000-01-01', factor: -1, offset: 0 }], '2026-07-10'))
    .toMatchObject({ structural: ['invalid_factor'], missingPreviousClose: ['2026-07-10'] });
});
