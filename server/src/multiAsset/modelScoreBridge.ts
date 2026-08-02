import { canonicalHash } from '../experiments/schema.js';
import {
  mlModelPlanSchema,
  modelTrainingRowSchema,
  type MlModelPlan,
  type ModelTrainingRow,
} from './mlModelSchema.js';
import { runModelWorker } from './modelWorkerClient.js';
import type { MultiAssetPlan, PointInTimeFeatureRow } from './schema.js';

// N2.4：模型→因子桥接。
// 模型分数注册为虚拟因子 `model:<modelType>`，写入时点特征行的
// factorValues 列，由 rankMultiFactor（E3）按普通因子参与截面排名。
// 模型本身不做独立资金账本，且分数进入计划 hash。

/** 模型虚拟因子 key，如 `model:ridge`。 */
export function modelFactorKey(modelType: string): string {
  return `model:${modelType}`;
}

export function isModelFactor(factorId: string): boolean {
  return factorId.startsWith('model:');
}

/**
 * 从时点特征行构造训练行。
 * label 来自调用方提供的标签映射（key = `${decisionDate}:${instrumentKey}`，
 * 时点口径由调用方保证，如从快照 bars 计算 future return）。
 * 无标签的行仍保留（预测段），但训练段（decisionDate <= trainedThrough）必须带标签。
 */
export function buildModelTrainingRows(input: {
  mlPlan: MlModelPlan;
  rows: PointInTimeFeatureRow[];
  labels?: Record<string, number | null>;
}): ModelTrainingRow[] {
  const { mlPlan, rows, labels } = input;
  const labelSource = labels ?? {};
  return rows.map((row) => {
    const features: Record<string, number | null> = {};
    for (const factorId of mlPlan.features) {
      if (isModelFactor(factorId)) continue;
      features[factorId] = row.factorValues?.[factorId] ?? null;
    }
    const key = `${row.decisionDate}:${row.instrumentKey}`;
    const label = labelSource[key] ?? null;
    return modelTrainingRowSchema.parse({
      decisionDate: row.decisionDate,
      instrumentKey: row.instrumentKey,
      features,
      label,
    });
  });
}

/**
 * 运行模型 worker 并把分数注入时点特征行。
 * 返回 { rows, artifact, scoreHash }；scoreHash 覆盖模型分数，
 * 使计划 hash 对模型产物敏感。
 */
export async function applyModelScores(input: {
  mlPlan: MlModelPlan;
  rows: PointInTimeFeatureRow[];
  enabled: boolean;
  pythonExecutable: string;
  workerPath?: string;
  labels?: Record<string, number | null>;
}): Promise<{
  rows: PointInTimeFeatureRow[];
  artifact: { sha256: string; byteSize: number };
  scoreHash: string;
  trainingRows: ModelTrainingRow[];
}> {
  const mlPlan = mlModelPlanSchema.parse(input.mlPlan);
  const trainingRows = buildModelTrainingRows({ mlPlan, rows: input.rows, labels: input.labels });
  const response = await runModelWorker({
    spec: mlPlan,
    rows: trainingRows,
    enabled: input.enabled,
    pythonExecutable: input.pythonExecutable,
    workerPath: input.workerPath,
  });
  if (response.scores.length !== trainingRows.length) throw new Error('ML_MODEL_SCORE_COUNT_MISMATCH');
  const scoreByKey = new Map(response.scores.map((score) => [
    `${score.decisionDate}:${score.instrumentKey}`,
    score.score,
  ]));
  const factorKey = modelFactorKey(mlPlan.modelType);
  const updatedRows = input.rows.map((row) => {
    const score = scoreByKey.get(`${row.decisionDate}:${row.instrumentKey}`);
    if (score === undefined) throw new Error('ML_MODEL_SCORE_MISSING_FOR_ROW');
    return {
      ...row,
      factorValues: {
        ...(row.factorValues ?? {}),
        [factorKey]: score,
      },
    };
  });
  const scoreHash = canonicalHash({ factorKey, scores: response.scores });
  return { rows: updatedRows, artifact: response.artifact, scoreHash, trainingRows };
}
