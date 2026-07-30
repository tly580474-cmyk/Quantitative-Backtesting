export const AUTO_CANDIDATE_THRESHOLDS = {
  minAbsRankIc: 0.02,
  minIcIr: 0.50,
  minIcTValue: 2.0,
  maxOosDecay: 0.30,
  minLockedRankIcRetention: 0.50,
  minCoverageRate: 0.70,
  maxLiquidityExposure: 0.30,
  maxPublishedFactorCorrelation: 0.70,
  minDeflatedSharpeProbability: 0.95,
  minStressedCostSharpe: 0,
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

  const validationRankIc = firstFinite(validation.test_rankic, validation.averageRankIc);
  const lockedRankIc = firstFinite(locked.averageRankIc, locked.rankIc);
  for (const [label, value] of [['validation', validationRankIc], ['locked test', lockedRankIc]] as const) {
    if (value === null || Math.abs(value) < AUTO_CANDIDATE_THRESHOLDS.minAbsRankIc) {
      failures.push(`${label} |RankIC| ${formatNumber(value)} < 0.0200`);
    }
  }

  const icir = firstFinite(locked.icir, validation.icir);
  if (icir === null || Math.abs(icir) < AUTO_CANDIDATE_THRESHOLDS.minIcIr) {
    failures.push(`ICIR ${formatNumber(icir)} < 0.5000`);
  }
  const icTValue = firstFinite(locked.icTValue, locked.ic_t, validation.icTValue, validation.ic_t);
  if (icTValue === null || Math.abs(icTValue) < AUTO_CANDIDATE_THRESHOLDS.minIcTValue) {
    failures.push(`IC t-value ${formatNumber(icTValue)} < 2.0000`);
  }

  const decay = finite(validation.oos_decay);
  if (decay === null) failures.push('out-of-sample decay is missing');
  else if (decay > AUTO_CANDIDATE_THRESHOLDS.maxOosDecay) {
    failures.push(`out-of-sample decay ${(decay * 100).toFixed(1)}% > 30.0%`);
  }
  if (validationRankIc === null || lockedRankIc === null) {
    failures.push('validation or locked-test RankIC is missing');
  } else if (validationRankIc * lockedRankIc <= 0) {
    failures.push('locked-test RankIC direction differs from validation');
  } else {
    const retention = Math.abs(lockedRankIc) / Math.max(Math.abs(validationRankIc), 1e-12);
    if (retention < AUTO_CANDIDATE_THRESHOLDS.minLockedRankIcRetention) {
      failures.push(`locked-test RankIC retention ${(retention * 100).toFixed(1)}% < 50.0%`);
    }
  }

  const coverage = finite(robustness.coverageRate);
  if (coverage === null || coverage < AUTO_CANDIDATE_THRESHOLDS.minCoverageRate) {
    failures.push(`coverage ${formatPct(coverage)} < 70.0%`);
  }
  const liquidityExposure = finite(robustness.liquidityExposure);
  if (liquidityExposure === null
    || Math.abs(liquidityExposure) > AUTO_CANDIDATE_THRESHOLDS.maxLiquidityExposure) {
    failures.push(`absolute liquidity exposure ${formatNumber(liquidityExposure)} > 0.3000`);
  }

  const correlation = finite(locked.maxPublishedFactorCorrelation);
  if (correlation === null
    || Math.abs(correlation) > AUTO_CANDIDATE_THRESHOLDS.maxPublishedFactorCorrelation) {
    failures.push(`published-factor correlation ${formatNumber(correlation)} > 0.7000`);
  }

  const dsr = firstFinite(
    locked.deflatedSharpeProbability,
    portfolio.deflatedSharpeProbability,
    validation.deflated_sharpe_probability,
  );
  if (dsr === null || dsr < AUTO_CANDIDATE_THRESHOLDS.minDeflatedSharpeProbability) {
    failures.push(`Deflated Sharpe probability ${formatPct(dsr)} < 95.0%`);
  }
  const stressedSharpe = firstFinite(portfolio.stressedCostSharpe, locked.stressedCostSharpe);
  if (stressedSharpe === null || stressedSharpe <= AUTO_CANDIDATE_THRESHOLDS.minStressedCostSharpe) {
    failures.push(`double-cost Sharpe ${formatNumber(stressedSharpe)} must be positive`);
  }

  return { passed: failures.length === 0, failures };
}

function formatPct(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(4);
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finite(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
