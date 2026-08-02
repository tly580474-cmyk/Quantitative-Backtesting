import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mlModelPlanSchema } from './mlModelSchema.js';
import { runModelWorker } from './modelWorkerClient.js';
import {
  applyModelScores,
  buildModelTrainingRows,
  isModelFactor,
  modelFactorKey,
} from './modelScoreBridge.js';
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

describe('N2 ML model schema and bridge', () => {
  it('validates the ml model plan protocol', () => {
    expect(mlPlan.modelType).toBe('ridge');
    expect(mlPlan.trainedThrough).toBe('2026-06-10');
    // 非法模型类型被拒绝
    expect(() => mlModelPlanSchema.parse({
      ...mlPlan,
      modelType: 'unknown_model',
    })).toThrow();
    // 训练截止必须晚于验证起始
    expect(() => mlModelPlanSchema.parse({
      ...mlPlan,
      trainedThrough: '2026-06-12',
      validationStartsAt: '2026-06-11',
    })).toThrow();
  });

  it('builds training rows from point-in-time feature rows', () => {
    const rows = buildModelTrainingRows({ mlPlan, rows: makeRows(), labels });
    expect(rows).toHaveLength(7);
    expect(rows[0].features).toEqual({ momentum_20: 1.2, reversal_5: -0.3 });
    expect(rows[0].label).toBe(0.05);
    // 训练截止后的行 label 为 null（仅预测）
    expect(rows[5].label).toBeNull();
  });

  it('exposes the model factor key', () => {
    expect(modelFactorKey('ridge')).toBe('model:ridge');
    expect(isModelFactor('model:ridge')).toBe(true);
    expect(isModelFactor('momentum_20')).toBe(false);
  });

  it('runs the sklearn ridge worker and injects scores into rows', async () => {
    const applied = await applyModelScores({
      mlPlan,
      rows: makeRows(),
      labels,
      enabled: true,
      pythonExecutable: 'python',
      workerPath: resolve('../tools/model-worker/model_worker.py'),
    });
    expect(applied.rows).toHaveLength(7);
    expect(applied.artifact.sha256).toHaveLength(64);
    expect(applied.scoreHash).toHaveLength(64);
    // 所有行都注入 model:ridge 分数
    for (const row of applied.rows) {
      expect(typeof row.factorValues?.['model:ridge']).toBe('number');
      expect(Number.isFinite(row.factorValues?.['model:ridge'])).toBe(true);
    }
    // 分数 hash 对模型产物敏感：改变特征应改变分数
    const changed = await applyModelScores({
      mlPlan,
      rows: makeRows().map((row, index) => index === 0
        ? { ...row, factorValues: { ...row.factorValues, momentum_20: 9.9 } } : row),
      labels,
      enabled: true,
      pythonExecutable: 'python',
      workerPath: resolve('../tools/model-worker/model_worker.py'),
    });
    expect(changed.scoreHash).not.toBe(applied.scoreHash);
  });

  it('is disabled unless explicitly enabled', async () => {
    await expect(runModelWorker({
      spec: mlPlan,
      rows: buildModelTrainingRows({ mlPlan, rows: makeRows(), labels }),
      enabled: false,
      pythonExecutable: 'python',
    })).rejects.toThrow('ML_MODEL_WORKER_DISABLED');
  });

  it('rejects when no training rows are available', async () => {
    await expect(runModelWorker({
      spec: mlPlan,
      rows: buildModelTrainingRows({ mlPlan, rows: makeRows(), labels: {} }),
      enabled: true,
      pythonExecutable: 'python',
      workerPath: resolve('../tools/model-worker/model_worker.py'),
    })).rejects.toThrow();
  });
});
