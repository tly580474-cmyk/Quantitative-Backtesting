import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mlModelPlanSchema, type MlModelPlan, type ModelTrainingRow } from './mlModelSchema.js';
import {
  evaluateModelRobustness,
  evaluateModelRobustnessChecks,
  shiftTrainedThroughDate,
} from './mlModelRobustness.js';
import type { PointInTimeFeatureRow } from './schema.js';

function makeRows(): PointInTimeFeatureRow[] {
  const base: Array<[string, string, number | null, number | null]> = [
    ['2026-06-01', '000001', 1.2, -0.3],
    ['2026-06-02', '000002', 0.8, 0.1],
    ['2026-06-03', '000003', 0.5, 0.4],
    ['2026-06-04', '000004', 1.5, -0.5],
    ['2026-06-05', '000005', 0.3, 0.2],
    ['2026-06-11', '000001', 1.1, -0.2],
    ['2026-06-11', '000002', 0.9, 0.0],
  ];
  return base.map(([decisionDate, instrumentKey, momentum, reversal]) => ({
    decisionDate,
    executableFrom: '2026-06-12',
    instrumentKey,
    memberFrom: '2026-01-01',
    memberTo: null,
    featureValue: momentum ?? null,
    factorValues: { momentum_20: momentum, reversal_5: reversal },
  }));
}

const mlPlan = mlModelPlanSchema.parse({
  protocolVersion: '1.0',
  modelType: 'ridge',
  features: ['momentum_20', 'reversal_5'],
  labelHorizonDays: 5,
  trainedThrough: '2026-06-10',
  seed: 42,
  hyperparameters: { modelType: 'ridge', alpha: 1 },
});

const labels: Record<string, number | null> = {
  '2026-06-01:000001': 0.05,
  '2026-06-02:000002': 0.02,
  '2026-06-03:000003': -0.01,
  '2026-06-04:000004': 0.08,
  '2026-06-05:000005': -0.02,
};

describe('N2.5 model robustness checks (pure)', () => {
  it('passes when perturbed scores preserve the ranking', () => {
    const baseline = [0.5, 0.3, 0.2, 0.1, -0.1];
    const result = evaluateModelRobustnessChecks({
      baseline,
      variants: [
        { name: '训练窗口扰动', scores: [0.49, 0.31, 0.21, 0.09, -0.12], minRankCorrelation: 0.9 },
        { name: '种子扰动', scores: [0.5, 0.3, 0.2, 0.1, -0.1], minRankCorrelation: 0.9 },
      ],
    });
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks).toHaveLength(2);
  });

  it('fails when a perturbed ranking flips direction', () => {
    const baseline = [0.5, 0.3, 0.2, 0.1, -0.1];
    const result = evaluateModelRobustnessChecks({
      baseline,
      variants: [
        { name: '训练窗口扰动', scores: [-0.5, -0.3, -0.2, -0.1, 0.1], minRankCorrelation: 0.9 },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.includes('训练窗口扰动'))).toBe(true);
  });

  it('fails when perturbed scores are uncorrelated', () => {
    const baseline = [0.5, 0.3, 0.2, 0.1, -0.1];
    const result = evaluateModelRobustnessChecks({
      baseline,
      variants: [
        { name: '特征扰动', scores: [10, -3, 7, 0.5, 2], minRankCorrelation: 0.95 },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('特征扰动');
  });

  it('treats constant scores and failed runs as unevaluable', () => {
    const result = evaluateModelRobustnessChecks({
      baseline: [0.5, 0.3, 0.2, 0.1, -0.1],
      variants: [
        { name: '恒定分数', scores: [1, 1, 1, 1, 1], minRankCorrelation: 0.9 },
        { name: '运行失败', scores: null, minRankCorrelation: 0.9 },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
  });
});

describe('N2.5 shiftTrainedThroughDate', () => {
  it('shifts the training end by unique decision days', () => {
    expect(shiftTrainedThroughDate(mlPlan, makeRows(), -3)).toBe('2026-06-02');
    expect(shiftTrainedThroughDate(mlPlan, makeRows(), 3)).toBe('2026-06-11');
  });

  it('anchors to the nearest decision day at or before trainedThrough', () => {
    const plan = mlModelPlanSchema.parse({ ...mlPlan, trainedThrough: '2026-06-03' });
    expect(shiftTrainedThroughDate(plan, makeRows(), -1)).toBe('2026-06-02');
  });

  it('clamps out-of-range shifts and respects validationStartsAt', () => {
    expect(shiftTrainedThroughDate(mlPlan, makeRows(), -99)).toBe('2026-06-01');
    expect(shiftTrainedThroughDate(mlPlan, makeRows(), 99)).toBe('2026-06-11');
    const validated = mlModelPlanSchema.parse({
      ...mlPlan,
      trainedThrough: '2026-06-02',
      validationStartsAt: '2026-06-05',
    });
    // 前移受验证边界约束：训练截止必须早于 2026-06-05
    expect(shiftTrainedThroughDate(validated, makeRows(), 3)).toBe('2026-06-04');
  });
});

describe('N2.5 evaluateModelRobustness (orchestration)', () => {
  it('constructs window/seed/feature variants and reports pass', async () => {
    const calls: Array<{ plan: MlModelPlan; rows: ModelTrainingRow[] }> = [];
    const result = await evaluateModelRobustness({
      mlPlan,
      rows: makeRows(),
      labels,
      enabled: false,
      pythonExecutable: 'python',
      runner: async (_plan, rows) => {
        calls.push({ plan: _plan, rows });
        return rows.map((row, index) => (row.label ?? 0) + index * 0.001);
      },
    });
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.map((check) => check.name)).toEqual([
      '训练窗口扰动(±3日)',
      '种子扰动(seed+1)',
      '特征扰动(首特征±0.5%)',
    ]);
    const trainedThroughSet = new Set(calls.map((call) => call.plan.trainedThrough));
    expect(trainedThroughSet.has('2026-06-02')).toBe(true);
    expect(trainedThroughSet.has('2026-06-11')).toBe(true);
    expect(calls.some((call) => call.plan.seed === 43)).toBe(true);
    // 特征扰动变体：首特征被确定性改写
    const perturbedCall = calls.find((call) => call.rows.some(
      (row, index) => row.features['momentum_20'] !== (makeRows()[index].factorValues?.['momentum_20'] ?? null),
    ));
    expect(perturbedCall).toBeDefined();
  });

  it('fails fast when the worker is disabled and no runner is given', async () => {
    const result = await evaluateModelRobustness({
      mlPlan,
      rows: makeRows(),
      labels,
      enabled: false,
      pythonExecutable: 'python',
    });
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('disabled');
  });

  it('runs the real sklearn ridge worker and passes all robustness checks', async () => {
    const result = await evaluateModelRobustness({
      mlPlan,
      rows: makeRows(),
      labels,
      enabled: true,
      pythonExecutable: 'python',
      workerPath: resolve('../tools/model-worker/model_worker.py'),
    });
    expect(result.passed).toBe(true);
    for (const check of result.checks) {
      expect(check.rankCorrelation).not.toBeNull();
    }
  }, 120_000);
});
