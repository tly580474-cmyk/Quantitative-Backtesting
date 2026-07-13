export interface CandidateReleaseGateResult {
  passed: boolean;
  failures: string[];
}

export function evaluateCandidateReleaseGate(metrics: unknown, validationMetrics?: unknown): CandidateReleaseGateResult {
  const value = metrics && typeof metrics === 'object' ? metrics as Record<string, unknown> : {};
  const failures: string[] = [];
  const validation = validationMetrics && typeof validationMetrics === 'object'
    ? validationMetrics as Record<string, unknown> : {};
  const sampleCount = finite(value.sampleCount);
  const tradingDays = finite(value.tradingDays);
  const rankIc = finite(value.averageRankIc);
  const positiveRate = finite(value.rankIcPositiveRate);
  const spread = finite(value.longShortSpread);
  const portfolio = value.portfolio && typeof value.portfolio === 'object'
    ? value.portfolio as Record<string, unknown> : {};
  const robustness = value.robustness && typeof value.robustness === 'object'
    ? value.robustness as Record<string, unknown> : {};
  const stressedSharpe = finite(portfolio.stressedCostSharpe);
  const coverage = finite(robustness.coverageRate);
  const maxCorrelation = finite(value.maxPublishedFactorCorrelation);
  const marginalIc = finite(value.marginalInformationIc);
  const deflatedSharpe = finite(validation.deflated_sharpe_probability);
  if (sampleCount === null || sampleCount < 1000) failures.push('锁定测试样本数不足 1000');
  if (tradingDays === null || tradingDays < 60) failures.push('锁定测试交易日不足 60');
  if (rankIc === null || Math.abs(rankIc) < 0.02) failures.push('锁定测试 |RankIC| 低于 0.02');
  if (positiveRate === null || positiveRate < 0.55) failures.push('RankIC 正向比例低于 55%');
  if (spread === null || spread <= 0) failures.push('锁定测试多空收益差不为正');
  if (stressedSharpe === null || stressedSharpe <= 0) failures.push('双倍成本压力下夏普不为正');
  if (coverage === null || coverage < 0.7) failures.push('因子有效覆盖率低于 70%');
  if (maxCorrelation === null || maxCorrelation > 0.7) failures.push('与正式因子最大相关性高于 0.70');
  if (marginalIc === null || Math.abs(marginalIc) < 0.01) failures.push('正交化后的边际 IC 低于 0.01');
  if (deflatedSharpe === null || deflatedSharpe < 0.95) failures.push('验证集 Deflated Sharpe 概率低于 95%');
  return { passed: failures.length === 0, failures };
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
