import type mysql from 'mysql2/promise';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { roundMoney } from '../../../shared/trading-rules/index.js';
import { TRADING_RULES_VERSION } from '../../../shared/trading-rules/index.js';

export const PAPER_RISK_RULES_VERSION = `paper-risk-${TRADING_RULES_VERSION}`;

export type PaperRiskRuleCode =
  | 'max_single_position_ratio'
  | 'max_total_position_ratio'
  | 'max_order_amount'
  | 'max_daily_turnover'
  | 'max_daily_orders'
  | 'max_drawdown_ratio'
  | 'max_daily_loss'
  | 'account_inactive';

export interface PaperRiskConfig {
  id: string;
  accountId: string;
  maxSinglePositionRatio: number | null;
  maxTotalPositionRatio: number | null;
  maxOrderAmount: number | null;
  maxDailyTurnover: number | null;
  maxDailyOrders: number | null;
  maxDrawdownRatio: number | null;
  maxDailyLoss: number | null;
  ruleVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPaperRiskConfigInput {
  accountId: string;
  maxSinglePositionRatio?: number | null;
  maxTotalPositionRatio?: number | null;
  maxOrderAmount?: number | null;
  maxDailyTurnover?: number | null;
  maxDailyOrders?: number | null;
  maxDrawdownRatio?: number | null;
  maxDailyLoss?: number | null;
}

export interface RiskEvaluationContext {
  accountId: string;
  side: 'buy' | 'sell';
  securityCode: string;
  instrumentKey: number;
  quantity: number;
  estimatePrice: number;
  orderAmount: number;
  currentCash: number;
  currentFrozenCash: number;
  currentMarketValue: number;
  currentTotalEquity: number;
  currentInitialCash: number;
  currentSecurityPositionValue: number;
  todayTradeCount: number;
  todayTurnover: number;
  todayRealizedPnl: number;
  peakEquity: number | null;
  accountStatus: string;
}

export interface RiskViolation {
  ruleCode: PaperRiskRuleCode;
  reason: string;
  metricSnapshot: Record<string, unknown>;
}

export interface RiskCheckResult {
  passed: boolean;
  violations: RiskViolation[];
}

/**
 * 纯函数：根据风控配置与上下文评估委托是否通过。
 *
 * 设计原则：
 * - 卖出委托只校验通用规则（金额、笔数、单日成交），不校验仓位与回撤上限，
 *   以便持仓者能够止损退出；
 * - 买入委托需要校验单股仓位、总仓位、回撤和单日亏损上限；
 * - 风控规则的缺失（NULL）视为不限制，与"未配置=零容忍"区分开。
 */
export function evaluatePaperRisk(
  config: PaperRiskConfig | null,
  context: RiskEvaluationContext,
): RiskCheckResult {
  const violations: RiskViolation[] = [];
  if (!config) {
    return { passed: true, violations };
  }
  if (context.accountStatus !== 'active') {
    violations.push({
      ruleCode: 'account_inactive',
      reason: `账户当前状态为 ${context.accountStatus}，不允许下单`,
      metricSnapshot: { status: context.accountStatus },
    });
    return { passed: false, violations };
  }
  if (context.side === 'buy') {
    pushIfExceeds(
      violations,
      'max_order_amount',
      config.maxOrderAmount,
      context.orderAmount,
      `单笔委托金额 ${context.orderAmount.toFixed(2)} 超过上限`,
      { orderAmount: context.orderAmount, limit: config.maxOrderAmount },
    );
    pushIfExceeds(
      violations,
      'max_single_position_ratio',
      config.maxSinglePositionRatio,
      ratioAfterBuy(context),
      `单股仓位占比 ${(ratioAfterBuy(context) * 100).toFixed(2)}% 超过上限`,
      {
        currentSecurityPositionValue: context.currentSecurityPositionValue,
        orderAmount: context.orderAmount,
        totalEquity: context.currentTotalEquity,
        limit: config.maxSinglePositionRatio,
      },
    );
    pushIfExceeds(
      violations,
      'max_total_position_ratio',
      config.maxTotalPositionRatio,
      totalRatioAfterBuy(context),
      `账户总仓位占比 ${(totalRatioAfterBuy(context) * 100).toFixed(2)}% 超过上限`,
      {
        currentMarketValue: context.currentMarketValue,
        orderAmount: context.orderAmount,
        totalEquity: context.currentTotalEquity,
        limit: config.maxTotalPositionRatio,
      },
    );
    pushIfExceeds(
      violations,
      'max_drawdown_ratio',
      config.maxDrawdownRatio,
      drawdownRatio(context),
      `账户回撤 ${(drawdownRatio(context) * 100).toFixed(2)}% 超过上限`,
      {
        peakEquity: context.peakEquity,
        currentEquity: context.currentTotalEquity,
        limit: config.maxDrawdownRatio,
      },
    );
    if (
      config.maxDailyLoss != null
      && context.todayRealizedPnl <= -config.maxDailyLoss
    ) {
      violations.push({
        ruleCode: 'max_daily_loss',
        reason: `当日已实现亏损 ${context.todayRealizedPnl.toFixed(2)} 元触及上限 ${(-config.maxDailyLoss).toFixed(2)} 元`,
        metricSnapshot: {
          todayRealizedPnl: context.todayRealizedPnl,
          limit: -config.maxDailyLoss,
        },
      });
    }
  } else {
    pushIfExceeds(
      violations,
      'max_order_amount',
      config.maxOrderAmount,
      context.orderAmount,
      `单笔委托金额 ${context.orderAmount.toFixed(2)} 超过上限`,
      { orderAmount: context.orderAmount, limit: config.maxOrderAmount },
    );
  }
  pushIfExceeds(
    violations,
    'max_daily_turnover',
    config.maxDailyTurnover,
    roundMoney(context.todayTurnover + context.orderAmount),
    `当日累计成交金额 ${(context.todayTurnover + context.orderAmount).toFixed(2)} 元超过上限`,
    {
      todayTurnover: context.todayTurnover,
      orderAmount: context.orderAmount,
      limit: config.maxDailyTurnover,
    },
  );
  if (
    config.maxDailyOrders != null
    && context.todayTradeCount + 1 > config.maxDailyOrders
  ) {
    violations.push({
      ruleCode: 'max_daily_orders',
      reason: `当日累计委托 ${context.todayTradeCount} 笔，加本笔将超过上限 ${config.maxDailyOrders} 笔`,
      metricSnapshot: {
        todayTradeCount: context.todayTradeCount,
        limit: config.maxDailyOrders,
      },
    });
  }
  return { passed: violations.length === 0, violations };
}

function pushIfExceeds(
  violations: RiskViolation[],
  ruleCode: PaperRiskRuleCode,
  limit: number | null,
  actual: number,
  reason: string,
  metricSnapshot: Record<string, unknown>,
) {
  if (limit == null) return;
  if (actual > limit + 1e-9) {
    violations.push({ ruleCode, reason, metricSnapshot });
  }
}

function ratioAfterBuy(context: RiskEvaluationContext): number {
  if (context.currentTotalEquity <= 0) return 1;
  return (context.currentSecurityPositionValue + context.orderAmount)
    / context.currentTotalEquity;
}

function totalRatioAfterBuy(context: RiskEvaluationContext): number {
  if (context.currentTotalEquity <= 0) return 1;
  return (context.currentMarketValue + context.orderAmount)
    / context.currentTotalEquity;
}

function drawdownRatio(context: RiskEvaluationContext): number {
  if (!context.peakEquity || context.peakEquity <= 0) return 0;
  return Math.max(
    0,
    (context.peakEquity - context.currentTotalEquity) / context.peakEquity,
  );
}

interface RiskConfigRow extends RowDataPacket {
  id: string;
  account_id: string;
  max_single_position_ratio: string | null;
  max_total_position_ratio: string | null;
  max_order_amount: string | null;
  max_daily_turnover: string | null;
  max_daily_orders: number | null;
  max_drawdown_ratio: string | null;
  max_daily_loss: string | null;
  rule_version: string;
  created_at: string;
  updated_at: string;
}

export async function getPaperRiskConfig(
  pool: mysql.Pool,
  accountId: string,
): Promise<PaperRiskConfig | null> {
  const [rows] = await pool.execute<RiskConfigRow[]>(
    'SELECT * FROM paper_risk_configs WHERE account_id = ? LIMIT 1',
    [accountId],
  );
  return rows[0] ? mapRiskConfig(rows[0]) : null;
}

export async function upsertPaperRiskConfig(
  pool: mysql.Pool,
  input: UpsertPaperRiskConfigInput,
): Promise<PaperRiskConfig> {
  validateRiskConfigInput(input);
  const connection = await pool.getConnection();
  const id = crypto.randomUUID();
  const now = mysqlDateTime();
  try {
    await connection.beginTransaction();
    await lockAccount(connection, input.accountId);
    await connection.execute(
      `INSERT INTO paper_risk_configs (
        id, account_id,
        max_single_position_ratio, max_total_position_ratio,
        max_order_amount, max_daily_turnover, max_daily_orders,
        max_drawdown_ratio, max_daily_loss,
        rule_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        max_single_position_ratio = VALUES(max_single_position_ratio),
        max_total_position_ratio = VALUES(max_total_position_ratio),
        max_order_amount = VALUES(max_order_amount),
        max_daily_turnover = VALUES(max_daily_turnover),
        max_daily_orders = VALUES(max_daily_orders),
        max_drawdown_ratio = VALUES(max_drawdown_ratio),
        max_daily_loss = VALUES(max_daily_loss),
        rule_version = VALUES(rule_version),
        updated_at = VALUES(updated_at)`,
      [
        id,
        input.accountId,
        input.maxSinglePositionRatio ?? null,
        input.maxTotalPositionRatio ?? null,
        input.maxOrderAmount ?? null,
        input.maxDailyTurnover ?? null,
        input.maxDailyOrders ?? null,
        input.maxDrawdownRatio ?? null,
        input.maxDailyLoss ?? null,
        PAPER_RISK_RULES_VERSION,
        now,
        now,
      ],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return (await getPaperRiskConfig(pool, input.accountId))!;
}

export async function insertRiskEvent(
  pool: mysql.Pool,
  accountId: string,
  orderId: string | null,
  result: RiskCheckResult,
): Promise<void> {
  if (result.violations.length === 0) return;
  const now = mysqlDateTime();
  for (const violation of result.violations) {
    await pool.execute(
      `INSERT INTO paper_risk_events (
        id, account_id, order_id, rule_code, rule_version,
        metric_snapshot, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        accountId,
        orderId,
        violation.ruleCode,
        PAPER_RISK_RULES_VERSION,
        JSON.stringify(violation.metricSnapshot),
        violation.reason,
        now,
      ],
    );
  }
}

export async function countTodayRiskEvents(
  pool: mysql.Pool,
  accountId: string,
  tradeDate: string,
): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM paper_risk_events
     WHERE account_id = ? AND DATE(created_at) = ?`,
    [accountId, tradeDate],
  );
  return Number(rows[0]?.count ?? 0);
}

function mapRiskConfig(row: RiskConfigRow): PaperRiskConfig {
  return {
    id: row.id,
    accountId: row.account_id,
    maxSinglePositionRatio: nullableNumber(row.max_single_position_ratio),
    maxTotalPositionRatio: nullableNumber(row.max_total_position_ratio),
    maxOrderAmount: nullableNumber(row.max_order_amount),
    maxDailyTurnover: nullableNumber(row.max_daily_turnover),
    maxDailyOrders: row.max_daily_orders == null ? null : Number(row.max_daily_orders),
    maxDrawdownRatio: nullableNumber(row.max_drawdown_ratio),
    maxDailyLoss: nullableNumber(row.max_daily_loss),
    ruleVersion: row.rule_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateRiskConfigInput(input: UpsertPaperRiskConfigInput) {
  const ratios: Array<[string, number | null | undefined]> = [
    ['maxSinglePositionRatio', input.maxSinglePositionRatio],
    ['maxTotalPositionRatio', input.maxTotalPositionRatio],
    ['maxDrawdownRatio', input.maxDrawdownRatio],
  ];
  for (const [name, value] of ratios) {
    if (value != null && (value < 0 || value > 1)) {
      throw new Error(`${name} 必须在 0~1 之间`);
    }
  }
  if (
    input.maxOrderAmount != null
    && input.maxOrderAmount <= 0
  ) {
    throw new Error('maxOrderAmount 必须大于 0');
  }
  if (
    input.maxDailyTurnover != null
    && input.maxDailyTurnover <= 0
  ) {
    throw new Error('maxDailyTurnover 必须大于 0');
  }
  if (
    input.maxDailyOrders != null
    && (input.maxDailyOrders < 1 || !Number.isInteger(input.maxDailyOrders))
  ) {
    throw new Error('maxDailyOrders 必须为正整数');
  }
  if (input.maxDailyLoss != null && input.maxDailyLoss <= 0) {
    throw new Error('maxDailyLoss 必须大于 0');
  }
}

async function lockAccount(
  connection: PoolConnection,
  accountId: string,
): Promise<void> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    'SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE',
    [accountId],
  );
  if (!rows[0]) {
    throw new Error(`模拟账户不存在：${accountId}`);
  }
}

function mysqlDateTime(value = new Date()) {
  return value.toISOString().slice(0, 23).replace('T', ' ');
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
