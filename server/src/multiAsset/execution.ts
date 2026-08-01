import { z } from 'zod';
import { multiAssetPlanSchema, validateRebalancePlan, type MultiAssetPlan, type RebalancePlan } from './schema.js';

const executionBarSchema = z.strictObject({
  tradeDate: z.iso.date(),
  instrumentKey: z.string().trim().min(1).max(80),
  open: z.number().finite().positive(),
  tradable: z.boolean(),
});

export type ExecutionBar = z.infer<typeof executionBarSchema>;

export interface PortfolioOrder {
  tradeDate: string;
  instrumentKey: string;
  side: 'buy' | 'sell';
  quantity: number;
  fillPrice: number;
  grossAmount: number;
  fees: number;
  reason: 'rebalance';
}

export interface PortfolioLedgerEntry {
  tradeDate: string;
  cash: number;
  marketValue: number;
  equity: number;
  cumulativeCosts: number;
  positions: Array<{ instrumentKey: string; quantity: number; markPrice: number; marketValue: number }>;
}

export interface PortfolioExecutionResult {
  protocolVersion: '1.0';
  initialCash: number;
  orders: PortfolioOrder[];
  ledger: PortfolioLedgerEntry[];
}

/**
 * M4 基础撮合核心：只处理目标权重、下一交易日开盘、只做多和整手。
 * 停牌残留已按 tradable=false 保留；涨跌停、容量和逐日盯市尚未在此阶段实现。
 */
export function executeRebalancePlan(input: {
  sourcePlan: unknown;
  rebalancePlan: unknown;
  bars: unknown[];
  initialCash: number;
}): PortfolioExecutionResult {
  const sourcePlan = multiAssetPlanSchema.parse(input.sourcePlan);
  const rebalancePlan = validateRebalancePlan(input.rebalancePlan, sourcePlan);
  const bars = input.bars.map((bar) => executionBarSchema.parse(bar));
  if (!Number.isFinite(input.initialCash) || input.initialCash <= 0) throw new Error('INVALID_INITIAL_CASH');
  const barMap = new Map(bars.map((bar) => [`${bar.tradeDate}:${bar.instrumentKey}`, bar]));
  const positions = new Map<string, number>();
  const orders: PortfolioOrder[] = [];
  const ledger: PortfolioLedgerEntry[] = [];
  let cash = input.initialCash;
  let cumulativeCosts = 0;

  for (const decision of rebalancePlan.decisions) {
    const date = decision.executableFrom;
    const instruments = new Set([...positions.keys(), ...decision.targets.map((target) => target.instrumentKey)]);
    const marks = new Map<string, number>();
    for (const instrumentKey of instruments) {
      const bar = barMap.get(`${date}:${instrumentKey}`);
      if (!bar) throw new Error(`EXECUTION_BAR_MISSING:${date}:${instrumentKey}`);
      marks.set(instrumentKey, bar.open);
    }
    const equityBefore = cash + [...positions].reduce(
      (sum, [instrumentKey, quantity]) => sum + quantity * marks.get(instrumentKey)!, 0,
    );
    const desired = new Map(decision.targets.map((target) => [
      target.instrumentKey,
      roundDownLot(equityBefore * target.targetWeight / marks.get(target.instrumentKey)!, sourcePlan.portfolioPlan.lotSize),
    ]));

    for (const instrumentKey of [...positions.keys()].sort()) {
      const current = positions.get(instrumentKey) ?? 0;
      const target = desired.get(instrumentKey) ?? 0;
      if (target >= current) continue;
      const bar = barMap.get(`${date}:${instrumentKey}`)!;
      if (!bar.tradable) continue;
      const quantity = current - target;
      const fillPrice = bar.open * (1 - sourcePlan.executionPlan.slippageRate);
      const grossAmount = quantity * fillPrice;
      const fees = commission(sourcePlan, grossAmount) + grossAmount * sourcePlan.executionPlan.sellTaxRate;
      cash += grossAmount - fees;
      cumulativeCosts += fees;
      setPosition(positions, instrumentKey, target);
      orders.push({ tradeDate: date, instrumentKey, side: 'sell', quantity, fillPrice, grossAmount, fees, reason: 'rebalance' });
    }

    for (const target of decision.targets) {
      const instrumentKey = target.instrumentKey;
      const current = positions.get(instrumentKey) ?? 0;
      const wanted = desired.get(instrumentKey) ?? 0;
      if (wanted <= current) continue;
      const bar = barMap.get(`${date}:${instrumentKey}`)!;
      if (!bar.tradable) continue;
      const fillPrice = bar.open * (1 + sourcePlan.executionPlan.slippageRate);
      let quantity = wanted - current;
      while (quantity > 0) {
        const grossAmount = quantity * fillPrice;
        const fees = commission(sourcePlan, grossAmount);
        if (grossAmount + fees <= cash + 1e-9) break;
        quantity -= sourcePlan.portfolioPlan.lotSize;
      }
      if (quantity <= 0) continue;
      const grossAmount = quantity * fillPrice;
      const fees = commission(sourcePlan, grossAmount);
      cash -= grossAmount + fees;
      cumulativeCosts += fees;
      setPosition(positions, instrumentKey, current + quantity);
      orders.push({ tradeDate: date, instrumentKey, side: 'buy', quantity, fillPrice, grossAmount, fees, reason: 'rebalance' });
    }

    if (cash < -1e-7) throw new Error('CASH_CONSERVATION_VIOLATION');
    const positionRows = [...positions].sort(([left], [right]) => left.localeCompare(right)).map(
      ([instrumentKey, quantity]) => {
        const markPrice = marks.get(instrumentKey)!;
        return { instrumentKey, quantity, markPrice, marketValue: quantity * markPrice };
      },
    );
    const marketValue = positionRows.reduce((sum, position) => sum + position.marketValue, 0);
    const equity = cash + marketValue;
    if (Math.abs(equity - (cash + marketValue)) > 1e-8) throw new Error('EQUITY_CONSERVATION_VIOLATION');
    ledger.push({ tradeDate: date, cash, marketValue, equity, cumulativeCosts, positions: positionRows });
  }
  return { protocolVersion: '1.0', initialCash: input.initialCash, orders, ledger };
}

function commission(plan: MultiAssetPlan, grossAmount: number): number {
  if (grossAmount <= 0) return 0;
  return Math.max(plan.executionPlan.minimumCommission, grossAmount * plan.executionPlan.commissionRate);
}

function roundDownLot(quantity: number, lotSize: number): number {
  return Math.max(0, Math.floor(quantity / lotSize) * lotSize);
}

function setPosition(positions: Map<string, number>, instrumentKey: string, quantity: number): void {
  if (quantity === 0) positions.delete(instrumentKey);
  else positions.set(instrumentKey, quantity);
}

export function assertPlanHasNoExecutionLedger(plan: RebalancePlan): void {
  const forbidden = ['cash', 'cashLedger', 'orders', 'positions', 'equity', 'finalEquity'];
  for (const key of forbidden) {
    if (key in (plan as unknown as Record<string, unknown>)) throw new Error(`COMPUTE_PLANE_OUTPUT_FORBIDDEN:${key}`);
  }
}
