import { generateRebalancePlan } from './duckdbPlanGenerator.js';
import { executeRebalancePlan } from './execution.js';
import { BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS } from './fixtures.js';

const rebalancePlan = await generateRebalancePlan(BASIC_MULTI_ASSET_PLAN, BASIC_POINT_IN_TIME_ROWS);
const result = executeRebalancePlan({
  sourcePlan: BASIC_MULTI_ASSET_PLAN,
  rebalancePlan,
  initialCash: 100_000,
  bars: [
    { tradeDate: '2026-07-03', instrumentKey: '600000.SH', open: 10, tradable: true },
    { tradeDate: '2026-07-03', instrumentKey: '000002.SZ', open: 20, tradable: true },
    { tradeDate: '2026-07-10', instrumentKey: '600000.SH', open: 11, tradable: true },
    { tradeDate: '2026-07-10', instrumentKey: '000002.SZ', open: 19, tradable: true },
    { tradeDate: '2026-07-10', instrumentKey: '000001.SZ', open: 12, tradable: true },
    { tradeDate: '2026-07-10', instrumentKey: '600001.SH', open: 8, tradable: true },
  ],
});

process.stdout.write(`${JSON.stringify({
  status: 'foundation_smoke_passed',
  planHash: rebalancePlan.planHash,
  decisions: rebalancePlan.decisions.length,
  orders: result.orders.length,
  endingEquity: result.ledger.at(-1)?.equity,
  note: 'This is the deterministic M4 foundation fixture, not production M4 completion.',
}, null, 2)}\n`);
