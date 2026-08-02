import {
  mlModelPlanSchema,
  type MlModelPlan,
  type ModelTrainingRow,
} from './mlModelSchema.js';
import { buildModelTrainingRows } from './modelScoreBridge.js';
import { runModelWorker } from './modelWorkerClient.js';
import type { PointInTimeFeatureRow } from './schema.js';

// N2.5：模型稳健性校验。
// 对模型计划施加三类扰动——训练窗口平移、随机种子偏移、特征列小幅扰动——
// 重跑模型并比较分数排序（Spearman 秩相关），把稳定性纳入门禁体系。
// 模式对齐 autoCandidateGate.ts：阈值常量 + 求值函数返回 { passed, failures }。
// 每次扰动结果只影响筛选排名，不改变权威引擎复算结论（ADR-05）。

export const ML_ROBUSTNESS_THRESHOLDS = {
  /** 训练窗口前后各平移的交易日数（按唯一决策日计） */
  windowShiftDays: 3,
  /** 训练窗口扰动最小 |秩相关| */
  minWindowShiftRankCorr: 0.9,
  /** 种子扰动最小 |秩相关| */
  minSeedShiftRankCorr: 0.9,
  /** 特征扰动最小 |秩相关| */
  minFeaturePerturbRankCorr: 0.95,
} as const;

export interface ModelRobustnessCheck {
  name: string;
  rankCorrelation: number | null;
  detail: string;
}

export interface ModelRobustnessResult {
  passed: boolean;
  failures: string[];
  checks: ModelRobustnessCheck[];
}

export interface ModelRobustnessVariant {
  name: string;
  scores: number[] | null;
  minRankCorrelation: number;
}

type ScoreRunner = (plan: MlModelPlan, rows: ModelTrainingRow[]) => Promise<number[]>;

/**
 * 纯函数：给定基线分数与各扰动变体分数，计算 Spearman 秩相关并给出
 * 门禁结论。扰动后排序反转（负相关）视为不稳定。分数与基线长度不一致、
 * 运行失败或分数恒定时视为无法评估。
 */
export function evaluateModelRobustnessChecks(input: {
  baseline: number[];
  variants: ModelRobustnessVariant[];
}): ModelRobustnessResult {
  const failures: string[] = [];
  const checks: ModelRobustnessCheck[] = [];
  for (const variant of input.variants) {
    const correlation = variant.scores === null
      ? null
      : spearmanRankCorrelation(input.baseline, variant.scores);
    const detail = variant.scores === null
      ? 'run failed'
      : correlation === null
        ? 'constant scores or length mismatch'
        : `rank correlation ${correlation.toFixed(4)}`;
    checks.push({ name: variant.name, rankCorrelation: correlation, detail });
    if (correlation === null) {
      failures.push(`${variant.name}: cannot evaluate (${detail})`);
    } else if (correlation < variant.minRankCorrelation) {
      failures.push(
        `${variant.name}: rank correlation ${correlation.toFixed(4)} < ${variant.minRankCorrelation.toFixed(2)}`,
      );
    }
  }
  return { passed: failures.length === 0, failures, checks };
}

/**
 * 将训练截止日平移 deltaDays 个唯一决策日（交易日口径），
 * 受 validationStartsAt 上界约束（训练截止必须早于验证起始）。
 * 越界时夹取到首个/末个决策日。
 */
export function shiftTrainedThroughDate(
  mlPlan: MlModelPlan,
  rows: PointInTimeFeatureRow[],
  deltaDays: number,
): string {
  const dates = [...new Set(rows.map((row) => row.decisionDate))].sort();
  let anchorIndex = dates.indexOf(mlPlan.trainedThrough);
  if (anchorIndex < 0) {
    // trainedThrough 非决策日时锚定到 <= 它的最近决策日（交易日口径）
    anchorIndex = -1;
    for (let i = 0; i < dates.length; i += 1) {
      if (dates[i] <= mlPlan.trainedThrough) anchorIndex = i;
      else break;
    }
    if (anchorIndex < 0) return mlPlan.trainedThrough;
  }
  const target = Math.min(Math.max(0, anchorIndex + deltaDays), dates.length - 1);
  let shifted = dates[target];
  if (mlPlan.validationStartsAt) {
    const beforeValidation = dates.filter((date) => date < mlPlan.validationStartsAt!);
    if (beforeValidation.length > 0 && shifted >= mlPlan.validationStartsAt!) {
      shifted = beforeValidation[beforeValidation.length - 1];
    }
  }
  return shifted;
}

/**
 * 运行完整稳健性校验：基线 + 训练窗口扰动（前/后移取更差方向）
 * + 种子扰动（seed+1）+ 特征扰动（首特征 ±0.5% 确定性噪声）。
 */
export async function evaluateModelRobustness(input: {
  mlPlan: MlModelPlan;
  rows: PointInTimeFeatureRow[];
  enabled: boolean;
  pythonExecutable: string;
  workerPath?: string;
  labels?: Record<string, number | null>;
  runner?: ScoreRunner;
}): Promise<ModelRobustnessResult> {
  if (!input.enabled && !input.runner) {
    return { passed: false, failures: ['model worker disabled: cannot evaluate robustness'], checks: [] };
  }
  const mlPlan = mlModelPlanSchema.parse(input.mlPlan);
  const trainingRows = buildModelTrainingRows({ mlPlan, rows: input.rows, labels: input.labels });
  const run = async (plan: MlModelPlan, rows: ModelTrainingRow[]): Promise<number[]> => {
    if (input.runner) return input.runner(plan, rows);
    const response = await runModelWorker({
      spec: plan,
      rows,
      enabled: true,
      pythonExecutable: input.pythonExecutable,
      workerPath: input.workerPath,
    });
    return response.scores.map((score) => score.score);
  };

  let baseline: number[];
  try {
    baseline = await run(mlPlan, trainingRows);
  } catch (error) {
    return { passed: false, failures: [`baseline model run failed: ${errorMessage(error)}`], checks: [] };
  }

  const variants: ModelRobustnessVariant[] = [];
  variants.push(await buildWindowShiftVariant(mlPlan, input.rows, trainingRows, baseline, run));
  variants.push(await buildSeedShiftVariant(mlPlan, trainingRows, baseline, run));
  variants.push(await buildFeaturePerturbVariant(mlPlan, trainingRows, baseline, run));
  return evaluateModelRobustnessChecks({ baseline, variants });
}

async function buildWindowShiftVariant(
  mlPlan: MlModelPlan,
  sourceRows: PointInTimeFeatureRow[],
  trainingRows: ModelTrainingRow[],
  baseline: number[],
  run: ScoreRunner,
): Promise<ModelRobustnessVariant> {
  const { windowShiftDays, minWindowShiftRankCorr } = ML_ROBUSTNESS_THRESHOLDS;
  const backPlan = shiftTrainedThroughDate(mlPlan, sourceRows, -windowShiftDays);
  const forwardPlan = shiftTrainedThroughDate(mlPlan, sourceRows, +windowShiftDays);
  const attempts: Array<{ plan: MlModelPlan; scores: number[] | null }> = [];
  for (const trainedThrough of new Set([backPlan, forwardPlan])) {
    if (trainedThrough === mlPlan.trainedThrough) continue;
    const plan = { ...mlPlan, trainedThrough };
    let scores: number[] | null = null;
    try {
      scores = await run(plan, trainingRows);
    } catch {
      scores = null;
    }
    attempts.push({ plan, scores });
  }
  const available = attempts.filter((attempt) => attempt.scores !== null);
  if (available.length === 0) {
    return { name: '训练窗口扰动', scores: null, minRankCorrelation: minWindowShiftRankCorr };
  }
  // 取与基线秩相关最低的方向（最坏情形，负相关表示排序反转）
  let worst = available[0];
  let worstCorr = spearmanRankCorrelation(baseline, worst.scores!) ?? Number.POSITIVE_INFINITY;
  for (const attempt of available.slice(1)) {
    const corr = spearmanRankCorrelation(baseline, attempt.scores!) ?? Number.POSITIVE_INFINITY;
    if (corr < worstCorr) {
      worst = attempt;
      worstCorr = corr;
    }
  }
  return {
    name: `训练窗口扰动(±${windowShiftDays}日)`,
    scores: worst.scores,
    minRankCorrelation: minWindowShiftRankCorr,
  };
}

async function buildSeedShiftVariant(
  mlPlan: MlModelPlan,
  trainingRows: ModelTrainingRow[],
  baseline: number[],
  run: ScoreRunner,
): Promise<ModelRobustnessVariant> {
  const { minSeedShiftRankCorr } = ML_ROBUSTNESS_THRESHOLDS;
  const seedPlan = { ...mlPlan, seed: Math.min(mlPlan.seed + 1, 2_147_483_647) };
  let scores: number[] | null = null;
  try {
    scores = await run(seedPlan, trainingRows);
  } catch {
    scores = null;
  }
  return { name: '种子扰动(seed+1)', scores, minRankCorrelation: minSeedShiftRankCorr };
}

async function buildFeaturePerturbVariant(
  mlPlan: MlModelPlan,
  trainingRows: ModelTrainingRow[],
  baseline: number[],
  run: ScoreRunner,
): Promise<ModelRobustnessVariant> {
  const { minFeaturePerturbRankCorr } = ML_ROBUSTNESS_THRESHOLDS;
  const featureId = mlPlan.features[0];
  let scores: number[] | null = null;
  try {
    const perturbed = trainingRows.map((row, index) => {
      const value = row.features[featureId];
      if (value === null || value === undefined) return row;
      const noise = 0.005 * Math.sin(index * 12.9898); // 确定性 ±0.5% 相对噪声
      return { ...row, features: { ...row.features, [featureId]: value * (1 + noise) } };
    });
    scores = await run(mlPlan, perturbed);
  } catch {
    scores = null;
  }
  return { name: '特征扰动(首特征±0.5%)', scores, minRankCorrelation: minFeaturePerturbRankCorr };
}

function spearmanRankCorrelation(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  return pearsonCorrelation(rankSeries(a), rankSeries(b));
}

function rankSeries(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((x, y) => x.value - y.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[indexed[k].index] = averageRank;
    i = j + 1;
  }
  return ranks;
}

function pearsonCorrelation(a: number[], b: number[]): number | null {
  const n = a.length;
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let i = 0; i < n; i += 1) {
    const devA = a[i] - meanA;
    const devB = b[i] - meanB;
    numerator += devA * devB;
    denominatorA += devA * devA;
    denominatorB += devB * devB;
  }
  if (denominatorA === 0 || denominatorB === 0) return null; // 恒定分数无法评估
  return numerator / Math.sqrt(denominatorA * denominatorB);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
