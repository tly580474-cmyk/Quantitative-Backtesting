export type StrategyStatus = 'draft' | 'validated' | 'paper' | 'champion' | 'rejected';

export interface PromotionMetrics {
  paperRebalanceCycles: number;
  annualExcessEligibleUniverse: number;
  annualExcessCsi500: number;
  informationRatioEligibleUniverse: number;
  informationRatioCsi500: number;
  maxDrawdown: number;
  stressedCostCumulativeReturn: number;
  positiveHistoricalRegimes: number;
  historicalRegimeCount: number;
  paperCumulativeExcessEligibleUniverse: number;
  paperCumulativeExcessCsi500: number;
  violations: string[];
}

export function evaluateStrategyPromotion(metrics: PromotionMetrics): {
  passed: boolean; failures: string[];
} {
  const failures: string[] = [];
  if (metrics.paperRebalanceCycles < 6) failures.push('paper observation requires 6 rebalance cycles');
  if (metrics.annualExcessEligibleUniverse < 0.03) {
    failures.push('annual excess vs eligible-universe equal weight is below 3%');
  }
  if (metrics.annualExcessCsi500 < 0.03) failures.push('annual excess vs CSI 500 is below 3%');
  if (metrics.informationRatioEligibleUniverse < 0.5) {
    failures.push('information ratio vs eligible-universe equal weight is below 0.5');
  }
  if (metrics.informationRatioCsi500 < 0.5) {
    failures.push('information ratio vs CSI 500 is below 0.5');
  }
  if (metrics.maxDrawdown < -0.35) failures.push('maximum drawdown exceeds 35%');
  if (metrics.stressedCostCumulativeReturn <= 0) {
    failures.push('double-cost cumulative return must be positive');
  }
  if (metrics.historicalRegimeCount < 4 || metrics.positiveHistoricalRegimes < 3) {
    failures.push('at least 3 of 4 historical regimes must have positive excess');
  }
  if (metrics.paperCumulativeExcessEligibleUniverse <= 0
    || metrics.paperCumulativeExcessCsi500 <= 0) {
    failures.push('paper cumulative excess must be positive against both benchmarks');
  }
  if (metrics.violations.length) failures.push(`unresolved violations: ${metrics.violations.join(', ')}`);
  return { passed: failures.length === 0, failures };
}

export function validateCompositeWeights(
  factors: Array<{ versionId: string; family: string; weight: number }>,
): void {
  if (factors.length < 5 || factors.length > 8) throw new Error('strategy requires 5 to 8 factors');
  const total = factors.reduce((sum, factor) => sum + factor.weight, 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error('factor weights must sum to one');
  if (factors.some((factor) => factor.weight < 0 || factor.weight > 0.30)) {
    throw new Error('factor weights must be non-negative and no greater than 30%');
  }
  const byFamily = new Map<string, number>();
  for (const factor of factors) {
    byFamily.set(factor.family, (byFamily.get(factor.family) ?? 0) + factor.weight);
  }
  if ([...byFamily.values()].some((weight) => weight > 0.40 + 1e-9)) {
    throw new Error('factor-family weight must not exceed 40%');
  }
}

export function nextStrategyStatus(current: StrategyStatus, action: string): StrategyStatus {
  const transitions: Record<StrategyStatus, Partial<Record<string, StrategyStatus>>> = {
    draft: { validate: 'validated', reject: 'rejected' },
    validated: { startPaper: 'paper', reject: 'rejected' },
    paper: { promote: 'champion', reject: 'rejected' },
    champion: { replace: 'validated' },
    rejected: {},
  };
  const next = transitions[current][action];
  if (!next) throw new Error(`strategy transition ${current} -> ${action} is not allowed`);
  return next;
}

export function isQuarterlyChallengerDue(lastCreatedAt: string | null, now: Date): boolean {
  if (!lastCreatedAt) return true;
  const last = new Date(lastCreatedAt);
  return last.getUTCFullYear() !== now.getUTCFullYear()
    || Math.floor(last.getUTCMonth() / 3) !== Math.floor(now.getUTCMonth() / 3);
}
