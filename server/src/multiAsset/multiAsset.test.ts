import { describe, expect, it } from 'vitest';
import { generateRebalancePlan } from './duckdbPlanGenerator.js';
import { executeRebalancePlan, assertPlanHasNoExecutionLedger } from './execution.js';
import { BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS } from './fixtures.js';
import { finalizeRebalancePlan, validateRebalancePlan } from './schema.js';

describe('M4 multi-asset foundation', () => {
  it('uses point-in-time membership and deterministically ranks weekly cross-sections', async () => {
    const plan = await generateRebalancePlan(BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS);
    expect(plan.decisions).toHaveLength(2);
    expect(plan.decisions[0].targets.map((item) => item.instrumentKey)).toEqual(['600000.SH', '000002.SZ']);
    expect(plan.decisions[1].eligibleUniverse).not.toContain('000002.SZ');
    expect(plan.decisions[1].targets.map((item) => item.instrumentKey)).toEqual(['000001.SZ', '600001.SH']);
    expect(plan.decisions[0].targets.map((item) => item.targetWeight)).toEqual([0.45, 0.45]);
    assertPlanHasNoExecutionLedger(plan);
  });

  it('does not let a later cross-section rewrite historical decisions', async () => {
    const original = await generateRebalancePlan(BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS);
    const extended = await generateRebalancePlan(BASIC_MULTI_ASSET_PLAN, [
      ...BASIC_POINT_IN_TIME_ROWS,
      { decisionDate: '2026-07-16', executableFrom: '2026-07-17', instrumentKey: '000001.SZ', memberFrom: '2025-01-01', memberTo: null, featureValue: -100 },
      { decisionDate: '2026-07-16', executableFrom: '2026-07-17', instrumentKey: '600001.SH', memberFrom: '2026-07-06', memberTo: null, featureValue: 100 },
    ]);
    expect(extended.decisions.slice(0, 2)).toEqual(original.decisions);
  });

  it('supports monthly score weighting without exceeding portfolio limits', async () => {
    const plan = await generateRebalancePlan({
      ...BASIC_MULTI_ASSET_PLAN,
      signalPlan: { ...BASIC_MULTI_ASSET_PLAN.signalPlan, weighting: 'score' },
      rebalancePolicy: { ...BASIC_MULTI_ASSET_PLAN.rebalancePolicy, frequency: 'monthly' },
    }, BASIC_POINT_IN_TIME_ROWS);
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0].decisionDate).toBe('2026-07-09');
    expect(plan.decisions[0].targets.map((target) => target.targetWeight)).toEqual([0.5, 0.4]);
  });

  it('rejects a tampered plan and compute-plane ledger fields', async () => {
    const plan = await generateRebalancePlan(BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS);
    expect(() => validateRebalancePlan({ ...plan, snapshotId: 'tampered' }, BASIC_MULTI_ASSET_PLAN))
      .toThrow('REBALANCE_PLAN_HASH_MISMATCH');
    expect(() => validateRebalancePlan({ ...plan, cashLedger: [] }, BASIC_MULTI_ASSET_PLAN)).toThrow();

    const { planHash: _featureHashIgnored, ...featureHashable } = plan;
    const badFeatureHash = finalizeRebalancePlan({
      ...featureHashable,
      decisions: [{
        ...plan.decisions[0],
        featureEvidence: plan.decisions[0].featureEvidence.map((item, index) => index === 0
          ? { ...item, featureValue: 999 } : item),
      }, ...plan.decisions.slice(1)],
    });
    expect(() => validateRebalancePlan(badFeatureHash, BASIC_MULTI_ASSET_PLAN))
      .toThrow('FEATURE_HASH_MISMATCH');

    const { planHash: _ignored, ...hashable } = plan;
    const outside = finalizeRebalancePlan({
      ...hashable,
      decisions: [{
        ...plan.decisions[0],
        targets: [{ ...plan.decisions[0].targets[0], instrumentKey: '999999.SZ' }],
      }, ...plan.decisions.slice(1)],
    });
    expect(() => validateRebalancePlan(outside, BASIC_MULTI_ASSET_PLAN))
      .toThrow('TARGET_OUTSIDE_POINT_IN_TIME_UNIVERSE');
  });

  it('executes one portfolio ledger with sell-before-buy and conserved cash/equity', async () => {
    const rebalancePlan = await generateRebalancePlan(BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS);
    const result = executeRebalancePlan({
      sourcePlan: BASIC_MULTI_ASSET_PLAN,
      rebalancePlan,
      initialCash: 100_000,
      bars: [
        { tradeDate: '2026-07-03', instrumentKey: '600000.SH', open: 10, tradable: true },
        { tradeDate: '2026-07-03', instrumentKey: '000002.SZ', open: 20, tradable: true },
        { tradeDate: '2026-07-10', instrumentKey: '600000.SH', open: 11, tradable: true },
        { tradeDate: '2026-07-10', instrumentKey: '000002.SZ', open: 19, tradable: true },
        { tradeDate: '2026-07-10', instrumentKey: '000001.SZ', open: 12, tradable: true },
        { tradeDate: '2026-07-10', instrumentKey: '600001.SH', open: 8, tradable: true },
      ],
    });
    expect(result.ledger).toHaveLength(2);
    expect(result.orders.filter((order) => order.tradeDate === '2026-07-10').map((order) => order.side))
      .toEqual(['sell', 'sell', 'buy', 'buy']);
    for (const entry of result.ledger) {
      expect(entry.cash).toBeGreaterThanOrEqual(0);
      expect(entry.equity).toBeCloseTo(entry.cash + entry.marketValue, 8);
      entry.positions.forEach((position) => expect(position.quantity % 100).toBe(0));
    }
  });
});
