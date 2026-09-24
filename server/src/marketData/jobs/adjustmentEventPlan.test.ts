import { describe, expect, it } from 'vitest';
import { buildEventValidatedPlan } from './adjustmentEventPlan.js';

const input = {
  start: '2026-03-22', end: '2026-09-22',
  raw: [
    { tradeDate: '2026-03-20', open: 30, high: 31, low: 29, close: 30, sourceKey: 1 },
    { tradeDate: '2026-07-09', open: 24.27, high: 24.27, low: 24.27, close: 24.27, sourceKey: 2 },
    { tradeDate: '2026-07-10', open: 18.4, high: 18.99, low: 17.88, close: 18.63, previousClose: 18.48, sourceKey: 2 },
  ],
  factors: [{ effectiveDate: '2002-06-20', factor: 1, offset: 0 }],
  events: [{ date: '2026-07-10', cashPerShare: 0.25, sharesPerShare: 0.3 }],
  sina: [{ d: '2025-11-04', f: String(24.27 / ((24.27 - 0.25) / 1.3)) }, { d: '2026-07-10', f: '1' }],
};
describe('independently checked event plans', () => {
  it('restores a split and cash distribution while preserving old history composition', () => {
    const plan = buildEventValidatedPlan(input);
    expect(plan.changed).toBe(true);
    expect(plan.factors[0]).toMatchObject({ effectiveDate: '2002-06-20', factor: 1 / 1.3, offset: -0.25 / 1.3 });
    expect(plan.validation.withinTickRatio).toBe(1);
    expect(plan.formulaQfq[0].close).toBeCloseTo(18.476923, 5);
  });
  it('refuses source disagreements, absent boundaries and unknown rights events', () => {
    expect(() => buildEventValidatedPlan({ ...input, events: [{ ...input.events[0], cashPerShare: 0.5 }] })).toThrow(/disagree/);
    expect(() => buildEventValidatedPlan({ ...input, sina: [{ d: '1900-01-01', f: '1' }] })).toThrow(/missing/i);
    expect(() => buildEventValidatedPlan({ ...input, events: [] })).toThrow(/unaccounted/);
  });
  it('does not erase a factor already published beyond the audit anchor', () => {
    expect(() => buildEventValidatedPlan({ ...input, factors: [...input.factors, { effectiveDate: '2026-09-23', factor: 1, offset: 0 }] }))
      .toThrow(/beyond/);
  });
  it('also repairs persistent two-cent errors confirmed by both independent sources', () => {
    const plan = buildEventValidatedPlan({ ...input,
      raw: input.raw.map(r => ({ ...r, previousClose: undefined })),
      events: [{ date: '2026-07-10', cashPerShare: 0.02, sharesPerShare: 0 }],
      factors: [{ effectiveDate: '2002-06-20', factor: 1, offset: -0.04 }, { effectiveDate: '2026-07-10', factor: 1, offset: 0 }],
      sina: [{ d: '2025-11-04', f: String(24.27 / 24.25) }, { d: '2026-07-10', f: '1' }],
    });
    expect(plan.beforeValidation.maxAbsoluteError).toBeCloseTo(0.02, 8);
    expect(plan.changed).toBe(true);
  });
  it('does not publish an old anchor when the source already has a newer action', () => {
    expect(() => buildEventValidatedPlan({ ...input, sina: [...input.sina.map(f => ({ ...f, f: String(Number(f.f) * 1.4) })),
      { d: '2026-09-23', f: '1' }] })).toThrow(/newer/);
  });
});
