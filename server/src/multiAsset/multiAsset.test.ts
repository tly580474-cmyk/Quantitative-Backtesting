import { describe, expect, it } from 'vitest';
import { generateRebalancePlan } from './duckdbPlanGenerator.js';
import { executeRebalancePlan, assertPlanHasNoExecutionLedger } from './execution.js';
import { BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS } from './fixtures.js';
import { generateRebalancePlanWithPython } from './pythonPlanWorker.js';
import { buildMultiAssetRunInputHash } from './repository.js';
import { assertCrossRuntimeParity, assertSnapshotConfigSemantics } from './runService.js';
import { finalizeRebalancePlan, hashMultiAssetPlan, multiAssetPlanSchema, validateRebalancePlan } from './schema.js';
import { snapshotMultiAssetConfigSchema } from './snapshotInput.js';

describe('M4 multi-asset foundation', () => {
  it('keeps persisted run identity stable and rejects infeasible snapshot requests', () => {
    const left = buildMultiAssetRunInputHash({
      planVersionId: 'plan-1', planHash: 'a'.repeat(64), initialCash: 1_000_000,
    });
    const right = buildMultiAssetRunInputHash({
      initialCash: 1_000_000, planHash: 'a'.repeat(64), planVersionId: 'plan-1',
    });
    expect(left).toBe(right);
    expect(() => snapshotMultiAssetConfigSchema.parse({
      indexCode: '000852', startDate: '2026-01-01', endDate: '2026-02-01',
      frequency: 'weekly', topN: 10, weighting: 'equal',
      maxGrossExposure: 0.95, maxSingleWeight: 0.1, minCashWeight: 0.05,
    })).toThrow();
    expect(snapshotMultiAssetConfigSchema.parse({
      indexCode: '000905', startDate: '2026-01-01', endDate: '2026-02-01',
      frequency: 'weekly', topN: 10, weighting: 'equal',
      maxGrossExposure: 0.95, maxSingleWeight: 0.1, minCashWeight: 0.05,
    }).universeSpec).toEqual({ type: 'index', indexCode: '000905' });
    expect(snapshotMultiAssetConfigSchema.parse({
      universeSpec: { type: 'all_a', markets: ['SH', 'SZ', 'BJ'] },
      startDate: '2026-01-01', endDate: '2026-02-01', frequency: 'monthly',
      topN: 10, weighting: 'equal', maxGrossExposure: 0.95,
      maxSingleWeight: 0.1, minCashWeight: 0.05,
    }).universeSpec).toMatchObject({ type: 'all_a', minHistoryDays: 120, minValidBars20: 20 });
    expect(() => assertSnapshotConfigSemantics({
      indexCode: '000300', startDate: '2020-01-01', endDate: '2026-01-02',
      frequency: 'weekly', topN: 10, weighting: 'equal',
      maxGrossExposure: 0.95, maxSingleWeight: 0.1, minCashWeight: 0.05,
    })).toThrow('首期单次多资产研究区间不能超过五年');
    expect(() => assertSnapshotConfigSemantics({
      indexCode: '000300', startDate: '2026-01-01', endDate: '2026-02-01',
      frequency: 'weekly', topN: 2, weighting: 'equal',
      maxGrossExposure: 0.95, maxSingleWeight: 0.1, minCashWeight: 0.05,
    })).toThrow('入选数量与单标的权重上限无法达到目标总仓位');
    expect(() => assertSnapshotConfigSemantics({
      universeSpec: { type: 'all_a', markets: ['SH', 'SZ', 'BJ'] },
      startDate: '2023-01-01', endDate: '2026-02-01', frequency: 'weekly',
      topN: 10, weighting: 'equal', maxGrossExposure: 0.95,
      maxSingleWeight: 0.1, minCashWeight: 0.05,
    })).toThrow('全 A 单次研究区间不能超过两年');
  });

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

  it('combines momentum and reversal with canonical evidence and order-independent plan hashes', async () => {
    const factors = [
      {
        factorId: 'momentum_20', factorVersion: 'published-v1', direction: 'higher' as const,
        missing: 'exclude' as const, normalization: 'percentile' as const, weight: 1,
      },
      {
        factorId: 'reversal_5', factorVersion: 'published-v1', direction: 'higher' as const,
        missing: 'exclude' as const, normalization: 'percentile' as const, weight: 1,
      },
    ];
    const plan = {
      ...BASIC_MULTI_ASSET_PLAN,
      planVersion: '1.1' as const,
      factorPlan: { protocolVersion: '1.0' as const, weighting: 'equal' as const, factors },
    };
    const rows = [
      ['000001.SZ', 0.4, 0.1], ['000002.SZ', 0.3, 0.4],
      ['600000.SH', 0.2, 0.3], ['600001.SH', 0.1, 0.2],
    ].map(([instrumentKey, momentum, reversal]) => ({
      decisionDate: '2026-07-02', executableFrom: '2026-07-03', instrumentKey: String(instrumentKey),
      memberFrom: '2025-01-01', memberTo: null, featureValue: Number(momentum),
      factorValues: { momentum_20: Number(momentum), reversal_5: Number(reversal) },
    }));
    const result = await generateRebalancePlan(plan, rows);
    const pythonResult = await generateRebalancePlanWithPython({ plan, rows });
    expect(result.protocolVersion).toBe('1.1');
    expect(result.decisions[0].targets.map((target) => target.instrumentKey))
      .toEqual(['000002.SZ', '000001.SZ']);
    expect(result.decisions[0].featureEvidence.every((item) => item.evidenceHash)).toBe(true);
    expect(pythonResult.decisions).toEqual(result.decisions);
    expect(validateRebalancePlan(result, plan)).toEqual(result);
    expect(hashMultiAssetPlan(plan)).toBe(hashMultiAssetPlan({
      ...plan, factorPlan: { ...plan.factorPlan, factors: [...factors].reverse() },
    }));
    expect(hashMultiAssetPlan(plan)).not.toBe(hashMultiAssetPlan({
      ...plan,
      factorPlan: {
        ...plan.factorPlan,
        weighting: 'manual',
        factors: factors.map((factor, index) => ({ ...factor, weight: index === 0 ? 2 : 1 })),
      },
    }));
  });

  it('keeps Python and TypeScript identical for PIT fundamentals and industry-neutral optimization', async () => {
    const factors = [
      {
        factorId: 'momentum_20', factorVersion: 'published-v1', direction: 'higher' as const,
        missing: 'exclude' as const, normalization: 'zscore' as const, weight: 1,
      },
      {
        factorId: 'roe', factorVersion: 'financial-reports-v1', direction: 'higher' as const,
        missing: 'exclude' as const, normalization: 'zscore' as const, weight: 1,
      },
    ];
    const plan = {
      ...BASIC_MULTI_ASSET_PLAN,
      planVersion: '1.2' as const,
      factorPlan: { protocolVersion: '1.0' as const, weighting: 'equal' as const, factors },
      fundamentalPlan: {
        protocolVersion: '1.0' as const, datasetId: 'financial_reports', datasetChecksum: 'c'.repeat(64),
        maxStalenessDays: 550, fields: ['roe' as const],
      },
      industryPlan: {
        protocolVersion: '1.0' as const, datasetId: 'sw_industry_memberships',
        datasetChecksum: 'd'.repeat(64), taxonomy: 'SW2021' as const, level: 1 as const,
      },
      optimizerSpec: {
        protocolVersion: '1.0' as const,
        objective: 'expected_return_minus_risk_and_turnover' as const,
        mode: 'constrained' as const, riskAversion: 0.2, turnoverPenalty: 0.1,
        maxTurnover: 0.9, maxHoldings: 4,
        solver: {
          name: 'deterministic_projection' as const, version: '1.0' as const,
          tolerance: 1e-9, maxIterations: 200, seed: 7,
        },
        industryNeutral: {
          protocolVersion: '1.0' as const, taxonomy: 'SW2021' as const, level: 1 as const,
          benchmark: 'universe_equal' as const, maxActiveDeviation: 0.02, allowUnknown: false,
        },
      },
      signalPlan: { ...BASIC_MULTI_ASSET_PLAN.signalPlan, topN: 4 },
      portfolioPlan: { ...BASIC_MULTI_ASSET_PLAN.portfolioPlan, maxGrossExposure: 0.8, maxSingleWeight: 0.3, minCashWeight: 0.2 },
    };
    const rows = [
      ['000001.SZ', 0.4, 12, 0.20, '801010'],
      ['000002.SZ', 0.3, 11, 0.18, '801010'],
      ['600000.SH', 0.2, 9, 0.12, '801020'],
      ['600001.SH', 0.1, 8, 0.10, '801020'],
    ].map(([instrumentKey, momentum, roe, riskProxy, industryCode]) => ({
      decisionDate: '2026-07-02', executableFrom: '2026-07-03', instrumentKey: String(instrumentKey),
      memberFrom: '2025-01-01', memberTo: null, featureValue: Number(momentum), riskProxy: Number(riskProxy),
      factorValues: { momentum_20: Number(momentum), roe: Number(roe) },
      fundamentalEvidence: {
        reportPeriod: '2026-03-31', announcementDate: '2026-04-25', sourceVersion: 'report-v1',
        ageDays: 68, missingFields: [],
      },
      industryEvidence: {
        taxonomy: 'SW2021' as const, level1Code: String(industryCode), level1Name: `行业${industryCode}`,
        effectiveFrom: '2025-01-01', effectiveTo: null, sourceVersion: 'sw-v1',
      },
    }));
    const [typescriptResult, pythonResult] = await Promise.all([
      generateRebalancePlan(plan, rows), generateRebalancePlanWithPython({ plan, rows }),
    ]);
    expect(typescriptResult.protocolVersion).toBe('1.2');
    expect(typescriptResult.decisions[0].optimizerResult?.status).toBe('solved');
    expect(typescriptResult.decisions[0].featureEvidence.every((item) => (
      item.fundamentalEvidence && item.industryEvidence
    ))).toBe(true);
    expect(pythonResult.decisions).toEqual(typescriptResult.decisions);
    expect(validateRebalancePlan(pythonResult, plan)).toEqual(pythonResult);
  });

  it('rejects trained factor weights that overlap validation data', () => {
    expect(() => multiAssetPlanSchema.parse({
      ...BASIC_MULTI_ASSET_PLAN,
      planVersion: '1.1',
      factorPlan: {
        protocolVersion: '1.0', weighting: 'training_rank_ic',
        trainedThrough: '2026-07-01', validationStartsAt: '2026-07-01',
        factors: [
          { factorId: 'momentum_20', factorVersion: 'v1', direction: 'higher', missing: 'exclude', normalization: 'percentile', weight: 0.7 },
          { factorId: 'reversal_5', factorVersion: 'v1', direction: 'higher', missing: 'exclude', normalization: 'percentile', weight: 0.3 },
        ],
      },
    })).toThrow('TRAINING_WEIGHTS_MUST_PRECEDE_VALIDATION');
  });

  it('keeps Python and DuckDB decisions identical and lets TypeScript execute either plan', async () => {
    const [duckdbPlan, pythonPlan] = await Promise.all([
      generateRebalancePlan(BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS),
      generateRebalancePlanWithPython({ plan: BASIC_MULTI_ASSET_PLAN, rows: BASIC_POINT_IN_TIME_ROWS }),
    ]);
    expect(pythonPlan.featureEngineVersion).toBe('python-cross-sectional-v1');
    expect(pythonPlan.decisions).toEqual(duckdbPlan.decisions);
    const bars = [
      { tradeDate: '2026-07-03', instrumentKey: '600000.SH', open: 10, tradable: true },
      { tradeDate: '2026-07-03', instrumentKey: '000002.SZ', open: 20, tradable: true },
      { tradeDate: '2026-07-10', instrumentKey: '600000.SH', open: 11, tradable: true },
      { tradeDate: '2026-07-10', instrumentKey: '000002.SZ', open: 19, tradable: true },
      { tradeDate: '2026-07-10', instrumentKey: '000001.SZ', open: 12, tradable: true },
      { tradeDate: '2026-07-10', instrumentKey: '600001.SH', open: 8, tradable: true },
    ];
    const duckdbResult = executeRebalancePlan({
      sourcePlan: BASIC_MULTI_ASSET_PLAN, rebalancePlan: duckdbPlan, bars, initialCash: 100_000,
    });
    const pythonResult = executeRebalancePlan({
      sourcePlan: BASIC_MULTI_ASSET_PLAN, rebalancePlan: pythonPlan, bars, initialCash: 100_000,
    });
    expect(pythonResult).toEqual(duckdbResult);

    const scorePlan = {
      ...BASIC_MULTI_ASSET_PLAN,
      signalPlan: { ...BASIC_MULTI_ASSET_PLAN.signalPlan, weighting: 'score' as const },
      rebalancePolicy: { ...BASIC_MULTI_ASSET_PLAN.rebalancePolicy, frequency: 'monthly' as const },
    };
    const [duckdbScore, pythonScore] = await Promise.all([
      generateRebalancePlan(scorePlan, BASIC_POINT_IN_TIME_ROWS),
      generateRebalancePlanWithPython({ plan: scorePlan, rows: BASIC_POINT_IN_TIME_ROWS }),
    ]);
    expect(pythonScore.decisions).toEqual(duckdbScore.decisions);
    expect(() => assertCrossRuntimeParity(duckdbScore, {
      ...pythonScore,
      decisions: pythonScore.decisions.map((decision, index) => index === 0
        ? { ...decision, targets: decision.targets.slice(1) } : decision),
    })).toThrow('Python 与 DuckDB');
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

  it('marks daily, applies capacity and corporate actions, and blocks limit or suspended fills', async () => {
    const rebalancePlan = await generateRebalancePlan(BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS);
    const result = executeRebalancePlan({
      sourcePlan: BASIC_MULTI_ASSET_PLAN,
      rebalancePlan,
      initialCash: 100_000,
      bars: [
        { tradeDate: '2026-07-03', instrumentKey: '600000.SH', open: 10, close: 10, volume: 1_000, tradable: true },
        { tradeDate: '2026-07-03', instrumentKey: '000002.SZ', open: 20, close: 20, volume: 1_000, tradable: true },
        { tradeDate: '2026-07-06', instrumentKey: '600000.SH', open: 5, close: 5.2, volume: 2_000, corporateActionRatio: 2, tradable: true },
        { tradeDate: '2026-07-06', instrumentKey: '000002.SZ', open: 20, close: 21, volume: 2_000, tradable: true },
        { tradeDate: '2026-07-10', instrumentKey: '600000.SH', open: 4.5, close: 4.5, volume: 10_000, limitDown: 4.5, tradable: true },
        { tradeDate: '2026-07-10', instrumentKey: '000002.SZ', open: 21, close: 21, volume: 10_000, tradable: false },
        { tradeDate: '2026-07-10', instrumentKey: '000001.SZ', open: 12, close: 12, volume: 10_000, limitUp: 12, tradable: true },
        { tradeDate: '2026-07-10', instrumentKey: '600001.SH', open: 8, close: 8, volume: 10_000, limitUp: 8, tradable: true },
      ],
    });
    expect(result.ledger).toHaveLength(3);
    expect(result.orders.filter((order) => order.tradeDate === '2026-07-03').map((order) => order.quantity))
      .toEqual([100, 100]);
    expect(result.ledger[1].positions.find((position) => position.instrumentKey === '600000.SH')?.quantity)
      .toBe(200);
    expect(result.orders.filter((order) => order.tradeDate === '2026-07-10')).toHaveLength(0);
    result.ledger.forEach((entry) => expect(entry.equity).toBeCloseTo(entry.cash + entry.marketValue, 8));
  });
});
