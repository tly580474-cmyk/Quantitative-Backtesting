import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { generateRebalancePlan } from './duckdbPlanGenerator.js';
import { executeRebalancePlan } from './execution.js';
import { generateRebalancePlanWithPython } from './pythonPlanWorker.js';
import { loadSnapshotExecutionBars, loadSnapshotMomentumInput } from './snapshotInput.js';

const config = loadConfig();
const option = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const positionalSnapshotRoot = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const snapshotRoot = resolve(option('snapshot-root') ?? positionalSnapshotRoot ?? config.RESEARCH_SNAPSHOT_ROOT);
const universeArg = option('universe') ?? process.argv[3] ?? '000300';
const scope = option('scope') ?? process.argv[4] ?? 'foundation';
const universeSpec = universeArg === 'all_a' ? {
  type: 'all_a' as const,
  markets: ['SH', 'SZ', 'BJ'] as const,
  minHistoryDays: 120,
  minValidBars20: 20,
  maxSuspendedDays20: 5,
  minAverageAmount20: 0,
  excludeRiskNames: true,
} : { type: 'index' as const, indexCode: universeArg };
const factorPlan = scope === 'foundation' ? undefined : {
  protocolVersion: '1.0' as const,
  weighting: 'equal' as const,
  factors: [
    {
      factorId: 'momentum_20', factorVersion: 'published-v1', direction: 'higher' as const,
      missing: 'exclude' as const, winsorization: { method: 'percentile' as const, lower: 0.01, upper: 0.99 },
      normalization: 'zscore' as const, weight: 1,
    },
    {
      factorId: scope === 'fundamental' ? 'free_cash_flow_to_enterprise_value' : 'reversal_5',
      factorVersion: scope === 'fundamental' ? 'financial-reports-v1' : 'published-v1',
      direction: 'higher' as const, missing: 'exclude' as const,
      winsorization: { method: 'percentile' as const, lower: 0.01, upper: 0.99 },
      normalization: 'zscore' as const, weight: 1,
    },
  ],
};
const usesOptimizer = scope === 'optimizer' || scope === 'industry';
const input = await loadSnapshotMomentumInput({
  snapshotRoot,
  universeSpec,
  startDate: '2026-06-01',
  endDate: '2026-07-30',
  frequency: 'weekly',
  topN: 10,
  weighting: 'equal',
  maxGrossExposure: 0.95,
  maxSingleWeight: 0.1,
  minCashWeight: 0.05,
  factorPlan,
  fundamentalFields: scope === 'fundamental' ? ['free_cash_flow_to_enterprise_value'] : undefined,
  fundamentalMaxStalenessDays: scope === 'fundamental' ? 550 : undefined,
  optimizerSpec: usesOptimizer ? {
    protocolVersion: '1.0', objective: 'expected_return_minus_risk_and_turnover',
    mode: 'constrained', riskAversion: 0.2, turnoverPenalty: 0.1,
    maxTurnover: 0.8, maxHoldings: 10,
    solver: { name: 'deterministic_projection', version: '1.0', tolerance: 1e-8, maxIterations: 500, seed: 42 },
    industryNeutral: scope === 'industry' ? {
      protocolVersion: '1.0', taxonomy: 'SW2021', level: 1,
      benchmark: 'universe_equal', maxActiveDeviation: 0.02, allowUnknown: false,
    } : undefined,
  } : undefined,
});
const [duckdbPlan, pythonPlan] = await Promise.all([
  generateRebalancePlan(input.sourcePlan, input.rows),
  generateRebalancePlanWithPython({ plan: input.sourcePlan, rows: input.rows, timeoutMs: 60_000 }),
]);
if (JSON.stringify(duckdbPlan.decisions) !== JSON.stringify(pythonPlan.decisions)) {
  const differingIndex = duckdbPlan.decisions.findIndex((decision, index) => (
    JSON.stringify(decision) !== JSON.stringify(pythonPlan.decisions[index])
  ));
  const duckDecision = duckdbPlan.decisions[differingIndex];
  const pythonDecision = pythonPlan.decisions[differingIndex];
  throw new Error(`SNAPSHOT_CROSS_RUNTIME_PARITY_FAILED:${differingIndex}:${duckDecision?.decisionDate}`
    + `:${duckDecision?.optimizerResult?.resultHash}:${pythonDecision?.optimizerResult?.resultHash}`);
}
const bars = await loadSnapshotExecutionBars(snapshotRoot, duckdbPlan);
const result = executeRebalancePlan({
  sourcePlan: input.sourcePlan,
  rebalancePlan: duckdbPlan,
  bars,
  initialCash: 1_000_000,
});

process.stdout.write(`${JSON.stringify({
  status: `snapshot_${scope}_smoke_passed`,
  scope,
  provenance: input.provenance,
  filterAudit: input.sourcePlan.universePlan.filterAudit?.map((audit) => ({
    decisionDate: audit.decisionDate,
    candidates: audit.candidates,
    eligible: audit.eligible,
    exclusions: audit.exclusions.length,
    eligibleUniverseHash: audit.eligibleUniverseHash,
  })),
  planHash: duckdbPlan.planHash,
  decisions: duckdbPlan.decisions.length,
  pythonDuckdbParity: true,
  orders: result.orders.length,
  ledgerEntries: result.ledger.length,
  endingEquity: result.ledger.at(-1)?.equity,
    note: 'M4 v1 acceptance flow; fixed snapshot evidence only, not an investment return claim.',
}, null, 2)}\n`);
