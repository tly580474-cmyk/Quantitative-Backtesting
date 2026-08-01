import { resolve } from 'node:path';
import { generateRebalancePlan } from './duckdbPlanGenerator.js';
import { executeRebalancePlan } from './execution.js';
import { generateRebalancePlanWithPython } from './pythonPlanWorker.js';
import { loadSnapshotExecutionBars, loadSnapshotMomentumInput } from './snapshotInput.js';

const snapshotRoot = resolve(process.argv[2] ?? './data/research-snapshots');
const indexCode = process.argv[3] ?? '000300';
const input = await loadSnapshotMomentumInput({
  snapshotRoot,
  indexCode,
  startDate: '2026-06-01',
  endDate: '2026-07-30',
  frequency: 'weekly',
  topN: 10,
  weighting: 'equal',
  maxGrossExposure: 0.95,
  maxSingleWeight: 0.1,
  minCashWeight: 0.05,
});
const [duckdbPlan, pythonPlan] = await Promise.all([
  generateRebalancePlan(input.sourcePlan, input.rows),
  generateRebalancePlanWithPython({ plan: input.sourcePlan, rows: input.rows, timeoutMs: 60_000 }),
]);
if (JSON.stringify(duckdbPlan.decisions) !== JSON.stringify(pythonPlan.decisions)) {
  throw new Error('SNAPSHOT_CROSS_RUNTIME_PARITY_FAILED');
}
const bars = await loadSnapshotExecutionBars(snapshotRoot, duckdbPlan);
const result = executeRebalancePlan({
  sourcePlan: input.sourcePlan,
  rebalancePlan: duckdbPlan,
  bars,
  initialCash: 1_000_000,
});

process.stdout.write(`${JSON.stringify({
  status: 'snapshot_foundation_smoke_passed',
  provenance: input.provenance,
  planHash: duckdbPlan.planHash,
  decisions: duckdbPlan.decisions.length,
  pythonDuckdbParity: true,
  orders: result.orders.length,
  ledgerEntries: result.ledger.length,
  endingEquity: result.ledger.at(-1)?.equity,
    note: 'M4 v1 acceptance flow; fixed snapshot evidence only, not an investment return claim.',
}, null, 2)}\n`);
