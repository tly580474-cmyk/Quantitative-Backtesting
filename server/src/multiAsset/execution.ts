import { z } from 'zod';
import { multiAssetPlanSchema, validateRebalancePlan, type MultiAssetPlan, type RebalancePlan } from './schema.js';

const executionBarSchema = z.strictObject({
  tradeDate: z.iso.date(),
  instrumentKey: z.string().trim().min(1).max(80),
  open: z.number().finite().positive(),
  close: z.number().finite().positive().optional(),
  volume: z.number().finite().nonnegative().optional(),
  limitUp: z.number().finite().positive().nullable().optional(),
  limitDown: z.number().finite().positive().nullable().optional(),
  corporateActionRatio: z.number().finite().positive().default(1),
  cashDividendPerShare: z.number().finite().nonnegative().default(0),
  delisted: z.boolean().default(false),
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
  grossTraded: number;
  turnover: number;
  positions: Array<{ instrumentKey: string; quantity: number; markPrice: number; marketValue: number }>;
}

export interface PortfolioExecutionResult {
  protocolVersion: '1.0';
  initialCash: number;
  orders: PortfolioOrder[];
  ledger: PortfolioLedgerEntry[];
}

/**
 * M4 权威撮合核心：下一交易日开盘、只做多、整手、停牌/涨跌停、容量、
 * 部分成交、公司行为数量调整和逐日盯市。计算平面始终不能写入本账本。
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
  if (barMap.size !== bars.length) throw new Error('DUPLICATE_EXECUTION_BAR');
  const decisions = new Map(rebalancePlan.decisions.map((decision) => [decision.executableFrom, decision]));
  const firstExecutionDate = rebalancePlan.decisions[0].executableFrom;
  const dates = [...new Set(bars.map((bar) => bar.tradeDate))].filter((date) => date >= firstExecutionDate).sort();
  for (const decision of rebalancePlan.decisions) {
    if (!dates.includes(decision.executableFrom)) throw new Error(`EXECUTION_DATE_MISSING:${decision.executableFrom}`);
  }
  const positions = new Map<string, number>();
  const lastMarks = new Map<string, number>();
  const orders: PortfolioOrder[] = [];
  const ledger: PortfolioLedgerEntry[] = [];
  let cash = input.initialCash;
  let cumulativeCosts = 0;

  for (const date of dates) {
    let grossTraded = 0;
    const decision = decisions.get(date);
    const dayBars = bars.filter((bar) => bar.tradeDate === date);
    for (const bar of dayBars) {
      lastMarks.set(bar.instrumentKey, bar.close ?? bar.open);
      const current = positions.get(bar.instrumentKey) ?? 0;
      if (current > 0 && bar.cashDividendPerShare > 0) cash += current * bar.cashDividendPerShare;
      if (current > 0 && Math.abs(bar.corporateActionRatio - 1) > 1e-12) {
        setPosition(positions, bar.instrumentKey, current * bar.corporateActionRatio);
      }
    }
    const instruments = new Set([
      ...positions.keys(),
      ...(decision?.targets.map((target) => target.instrumentKey) ?? []),
    ]);
    const marks = new Map<string, number>();
    for (const instrumentKey of instruments) {
      const bar = barMap.get(`${date}:${instrumentKey}`);
      const mark = bar?.close ?? bar?.open ?? lastMarks.get(instrumentKey);
      if (mark == null) throw new Error(`EXECUTION_MARK_MISSING:${date}:${instrumentKey}`);
      marks.set(instrumentKey, mark);
    }
    if (decision) {
      const equityBefore = cash + [...positions].reduce(
        (sum, [instrumentKey, quantity]) => sum + quantity * marks.get(instrumentKey)!, 0,
      );
      const desired = new Map(decision.targets.map((target) => {
        const bar = barMap.get(`${date}:${target.instrumentKey}`);
        if (!bar) throw new Error(`EXECUTION_BAR_MISSING:${date}:${target.instrumentKey}`);
        return [target.instrumentKey, roundDownLot(
          equityBefore * target.targetWeight / bar.open,
          sourcePlan.portfolioPlan.lotSize,
        )];
      }));

      for (const instrumentKey of [...positions.keys()].sort()) {
        const current = positions.get(instrumentKey) ?? 0;
        const target = desired.get(instrumentKey) ?? 0;
        if (target >= current) continue;
        const bar = barMap.get(`${date}:${instrumentKey}`);
        if (!bar || !canSell(bar)) continue;
        const requested = current - target;
        const quantity = executableQuantity(requested, bar.volume, sourcePlan.portfolioPlan.lotSize);
        if (quantity <= 0) continue;
        const fillPrice = bar.open * (1 - sourcePlan.executionPlan.slippageRate);
        const grossAmount = quantity * fillPrice;
        const fees = commission(sourcePlan, grossAmount) + grossAmount * sourcePlan.executionPlan.sellTaxRate;
        cash += grossAmount - fees;
        cumulativeCosts += fees;
        grossTraded += grossAmount;
        setPosition(positions, instrumentKey, current - quantity);
        orders.push({ tradeDate: date, instrumentKey, side: 'sell', quantity, fillPrice, grossAmount, fees, reason: 'rebalance' });
      }

      for (const target of decision.targets) {
        const instrumentKey = target.instrumentKey;
        const current = positions.get(instrumentKey) ?? 0;
        const wanted = desired.get(instrumentKey) ?? 0;
        if (wanted <= current) continue;
        const bar = barMap.get(`${date}:${instrumentKey}`)!;
        if (!canBuy(bar)) continue;
        const fillPrice = bar.open * (1 + sourcePlan.executionPlan.slippageRate);
        let quantity = executableQuantity(wanted - current, bar.volume, sourcePlan.portfolioPlan.lotSize);
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
        grossTraded += grossAmount;
        setPosition(positions, instrumentKey, current + quantity);
        orders.push({ tradeDate: date, instrumentKey, side: 'buy', quantity, fillPrice, grossAmount, fees, reason: 'rebalance' });
      }
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
    ledger.push({
      tradeDate: date, cash, marketValue, equity, cumulativeCosts, grossTraded,
      turnover: equity > 0 ? grossTraded / equity : 0,
      positions: positionRows,
    });
  }
  return { protocolVersion: '1.0', initialCash: input.initialCash, orders, ledger };
}

function canBuy(bar: ExecutionBar): boolean {
  return bar.tradable && !bar.delisted && (bar.limitUp == null || bar.open < bar.limitUp - 1e-8);
}

function canSell(bar: ExecutionBar): boolean {
  return bar.tradable && (bar.limitDown == null || bar.open > bar.limitDown + 1e-8);
}

function executableQuantity(requested: number, volume: number | undefined, lotSize: number): number {
  const capacity = volume == null ? requested : Math.min(requested, volume * 0.10);
  return roundDownLot(capacity, lotSize);
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
