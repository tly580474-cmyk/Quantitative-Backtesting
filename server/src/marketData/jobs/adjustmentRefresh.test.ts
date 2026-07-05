import { describe, expect, it } from 'vitest';
import {
  buildAdjustmentRefreshPlan,
  hasCorporateActionSignal,
} from './adjustmentRefresh.js';

describe('incremental adjustment refresh', () => {
  it('detects an official ex-right reference price change', () => {
    expect(hasCorporateActionSignal(10, 9.5)).toBe(true);
    expect(hasCorporateActionSignal(10, 10)).toBe(false);
    expect(hasCorporateActionSignal(undefined, 9.5)).toBe(false);
  });

  it('composes a new cash-dividend transform with historical factors', () => {
    const existing = [
      { effectiveDate: '2020-01-02', factor: 0.8, offset: -0.1 },
      { effectiveDate: '2025-01-02', factor: 1, offset: 0 },
    ];
    const raw = [
      { tradeDate: '2026-06-30', open: 10, high: 10.2, low: 9.8, close: 10 },
      { tradeDate: '2026-07-01', open: 10.1, high: 10.3, low: 9.9, close: 10.2 },
      { tradeDate: '2026-07-02', open: 9.6, high: 9.8, low: 9.4, close: 9.7 },
      { tradeDate: '2026-07-03', open: 9.8, high: 10, low: 9.6, close: 9.9 },
    ];
    const qfq = raw.map((row) => row.tradeDate < '2026-07-02'
      ? {
          ...row,
          open: row.open - 0.5,
          high: row.high - 0.5,
          low: row.low - 0.5,
          close: row.close - 0.5,
        }
      : row);

    const plan = buildAdjustmentRefreshPlan(existing, raw, qfq);

    expect(plan.changed).toBe(true);
    expect(plan.eventDate).toBe('2026-07-02');
    expect(plan.priorTransform.offset).toBeCloseTo(-0.5, 4);
    expect(plan.factors[0]).toMatchObject({
      effectiveDate: '2020-01-02',
      factor: expect.closeTo(0.8, 4),
      offset: expect.closeTo(-0.6, 4),
    });
    expect(plan.validation.withinTickRatio).toBeGreaterThanOrEqual(0.995);
  });

  it('does nothing when the published factors still reconstruct qfq', () => {
    const raw = [
      { tradeDate: '2026-07-02', open: 10, high: 11, low: 9, close: 10 },
      { tradeDate: '2026-07-03', open: 10.5, high: 11, low: 10, close: 10.8 },
    ];
    const factors = [{ effectiveDate: '2020-01-02', factor: 1, offset: 0 }];
    const plan = buildAdjustmentRefreshPlan(factors, raw, raw);
    expect(plan.changed).toBe(false);
    expect(plan.reason).toBe('unchanged');
  });
});
