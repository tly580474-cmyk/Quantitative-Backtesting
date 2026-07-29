export const AUTO_CANDIDATE_THRESHOLDS = {
  maxOosDecay: 0.30,
  minLockedRankIcRetention: 0.50,
  maxDrawdown: 0.15,
  minCoverageRate: 0.70,
  maxLiquidityExposure: 0.30,
  maxPublishedFactorCorrelation: 0.70,
} as const;

export interface AutoCandidateGateResult {
  passed: boolean;
  failures: string[];
}

export function evaluateAutoCandidateGate(
  validationMetrics: unknown,
  lockedTestMetrics: unknown,
): AutoCandidateGateResult {
  const validation = asRecord(validationMetrics);
  const locked = asRecord(lockedTestMetrics);
  const portfolio = asRecord(locked.portfolio);
  const robustness = asRecord(locked.robustness);
  const failures: string[] = [];

  const decay = finite(validation.oos_decay);
  const validationRankIc = finite(validation.test_rankic);
  const lockedRankIc = finite(locked.averageRankIc);
  if (decay === null) {
    failures.push('过拟合检查缺少样本外衰减数据');
  } else if (decay > AUTO_CANDIDATE_THRESHOLDS.maxOosDecay) {
    failures.push(`过拟合：样本外衰减 ${(decay * 100).toFixed(1)}% > 30.0%`);
  }
  if (validationRankIc === null || lockedRankIc === null) {
    failures.push('过拟合检查缺少验证或锁定 RankIC');
  } else if (validationRankIc * lockedRankIc <= 0) {
    failures.push(`过拟合：锁定 RankIC ${lockedRankIc.toFixed(4)} 与验证方向不一致`);
  } else {
    const retention = Math.abs(lockedRankIc) / Math.max(Math.abs(validationRankIc), 1e-12);
    if (retention < AUTO_CANDIDATE_THRESHOLDS.minLockedRankIcRetention) {
      failures.push(`过拟合：锁定 RankIC 仅保留验证值的 ${(retention * 100).toFixed(1)}% < 50.0%`);
    }
  }

  const drawdown = finite(portfolio.maxDrawdown);
  if (drawdown === null) {
    failures.push('回撤检查缺少最大回撤数据');
  } else if (Math.abs(Math.min(0, drawdown)) > AUTO_CANDIDATE_THRESHOLDS.maxDrawdown) {
    failures.push(`回撤过大：最大回撤 ${(Math.abs(drawdown) * 100).toFixed(1)}% > 15.0%`);
  }

  const coverage = finite(robustness.coverageRate);
  const liquidityExposure = finite(robustness.liquidityExposure);
  if (coverage === null || coverage < AUTO_CANDIDATE_THRESHOLDS.minCoverageRate) {
    failures.push(`流动性不合格：有效覆盖率 ${formatPct(coverage)} < 70.0%`);
  }
  if (liquidityExposure === null) {
    failures.push('流动性检查缺少流动性暴露数据');
  } else if (Math.abs(liquidityExposure) > AUTO_CANDIDATE_THRESHOLDS.maxLiquidityExposure) {
    failures.push(`流动性不合格：流动性暴露绝对值 ${Math.abs(liquidityExposure).toFixed(4)} > 0.3000`);
  }

  const correlation = finite(locked.maxPublishedFactorCorrelation);
  if (correlation === null) {
    failures.push('正式因子相关性检查缺少数据');
  } else if (Math.abs(correlation) > AUTO_CANDIDATE_THRESHOLDS.maxPublishedFactorCorrelation) {
    failures.push(`正式因子相关性 ${Math.abs(correlation).toFixed(4)} > 0.7000`);
  }
  return { passed: failures.length === 0, failures };
}

function formatPct(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
