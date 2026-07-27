import type mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { roundMoney } from '../../../shared/trading-rules/index.js';
import { TRADING_RULES_VERSION } from '../../../shared/trading-rules/index.js';

export const PAPER_EQUITY_SNAPSHOT_VERSION = `paper-equity-${TRADING_RULES_VERSION}`;

export type PreviousEquitySnapshot = Omit<EquitySnapshotSummary, 'createdAt'> & {
  createdAt?: string;
};

export interface EquitySnapshotInput {
  accountId: string;
  tradeDate: string;
  cashBalance: number;
  frozenCash: number;
  marketValue: number;
  initialCash: number;
  benchmarkCode?: string | null;
  benchmarkClose?: number | null;
  riskRejections: number;
  previousSnapshot?: PreviousEquitySnapshot | null;
}

export interface EquitySnapshotSummary {
  accountId: string;
  tradeDate: string;
  cashBalance: number;
  frozenCash: number;
  marketValue: number;
  totalEquity: number;
  initialCash: number;
  returnRatio: number;
  dailyReturnRatio: number | null;
  maxDrawdownRatio: number | null;
  peakEquity: number | null;
  benchmarkCode: string | null;
  benchmarkClose: number | null;
  riskRejections: number;
  ruleVersion: string;
  createdAt: string;
}

/**
 * 纯函数：基于账户当前状态与上一日快照计算当日权益快照指标。
 *
 * 不变量：
 * - 累计收益率 = totalEquity / initialCash - 1
 * - 当日收益率 = (totalEquity - prev.totalEquity) / prev.totalEquity（首日为 NULL）
 * - 历史峰值权益 = max(prev.peakEquity, totalEquity)，首日即 totalEquity
 * - 最大回撤 = (peakEquity - totalEquity) / peakEquity（peakEquity>0）
 */
export function computeEquitySnapshot(
  input: EquitySnapshotInput,
): Omit<EquitySnapshotSummary, 'createdAt'> {
  const totalEquity = roundMoney(input.cashBalance + input.marketValue);
  const initialCash = roundMoney(input.initialCash);
  const returnRatio = initialCash > 0
    ? totalEquity / initialCash - 1
    : 0;
  const prev = input.previousSnapshot;
  const dailyReturnRatio = prev && prev.totalEquity > 0
    ? totalEquity / prev.totalEquity - 1
    : null;
  const peakEquity = prev && prev.peakEquity != null
    ? Math.max(prev.peakEquity, totalEquity)
    : totalEquity;
  const maxDrawdownRatio = peakEquity > 0
    ? Math.max(0, (peakEquity - totalEquity) / peakEquity)
    : null;
  return {
    accountId: input.accountId,
    tradeDate: input.tradeDate,
    cashBalance: roundMoney(input.cashBalance),
    frozenCash: roundMoney(input.frozenCash),
    marketValue: roundMoney(input.marketValue),
    totalEquity,
    initialCash,
    returnRatio,
    dailyReturnRatio,
    maxDrawdownRatio,
    peakEquity,
    benchmarkCode: input.benchmarkCode ?? null,
    benchmarkClose: input.benchmarkClose ?? null,
    riskRejections: Math.max(0, Math.trunc(input.riskRejections)),
    ruleVersion: PAPER_EQUITY_SNAPSHOT_VERSION,
  };
}

interface AccountRow extends RowDataPacket {
  id: string;
  name: string;
  initial_cash: string;
  cash_balance: string;
  frozen_cash: string;
}

interface SnapshotRow extends RowDataPacket {
  id: string;
  account_id: string;
  trade_date: string;
  cash_balance: string;
  frozen_cash: string;
  market_value: string;
  total_equity: string;
  initial_cash: string;
  return_ratio: string;
  daily_return_ratio: string | null;
  max_drawdown_ratio: string | null;
  peak_equity: string | null;
  benchmark_code: string | null;
  benchmark_close: string | null;
  risk_rejections: number;
  rule_version: string;
  created_at: string;
}

interface RiskEventCountRow extends RowDataPacket {
  count: number;
}

/**
 * 为指定账户在指定交易日生成权益快照。重复调用使用 ON DUPLICATE KEY UPDATE
 * 覆盖当日记录，便于重试与回放。
 */
export async function recordPaperEquitySnapshot(
  pool: mysql.Pool,
  accountId: string,
  tradeDate: string,
  options?: {
    benchmarkCode?: string | null;
    benchmarkClose?: number | null;
  },
): Promise<EquitySnapshotSummary> {
  const [accountRows] = await pool.execute<AccountRow[]>(
    'SELECT id, name, initial_cash, cash_balance, frozen_cash FROM paper_accounts WHERE id = ? LIMIT 1',
    [accountId],
  );
  const account = accountRows[0];
  if (!account) {
    throw new Error(`模拟账户不存在：${accountId}`);
  }
  const [marketRow] = await pool.execute<RowDataPacket[]>(
    `SELECT COALESCE(SUM(market_value), 0) AS market_value
     FROM paper_positions WHERE account_id = ? AND total_quantity > 0`,
    [accountId],
  );
  const [riskRow] = await pool.execute<RiskEventCountRow[]>(
    `SELECT COUNT(*) AS count FROM paper_risk_events
     WHERE account_id = ? AND DATE(created_at) = ?`,
    [accountId, tradeDate],
  );
  const previous = await fetchPreviousSnapshot(pool, accountId, tradeDate);
  const snapshot = computeEquitySnapshot({
    accountId,
    tradeDate,
    cashBalance: Number(account.cash_balance),
    frozenCash: Number(account.frozen_cash),
    marketValue: Number(marketRow[0]?.market_value ?? 0),
    initialCash: Number(account.initial_cash),
    benchmarkCode: options?.benchmarkCode ?? null,
    benchmarkClose: options?.benchmarkClose ?? null,
    riskRejections: Number(riskRow[0]?.count ?? 0),
    previousSnapshot: previous,
  });
  const createdAt = await persistPaperEquitySnapshot(pool, snapshot);
  return { ...snapshot, createdAt };
}

async function persistPaperEquitySnapshot(
  pool: mysql.Pool,
  snapshot: Omit<EquitySnapshotSummary, 'createdAt'>,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = mysqlDateTime();
  await pool.execute(
    `INSERT INTO paper_equity_snapshots (
      id, account_id, trade_date,
      cash_balance, frozen_cash, market_value, total_equity, initial_cash,
      return_ratio, daily_return_ratio, max_drawdown_ratio, peak_equity,
      benchmark_code, benchmark_close, risk_rejections, rule_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      cash_balance = VALUES(cash_balance),
      frozen_cash = VALUES(frozen_cash),
      market_value = VALUES(market_value),
      total_equity = VALUES(total_equity),
      initial_cash = VALUES(initial_cash),
      return_ratio = VALUES(return_ratio),
      daily_return_ratio = VALUES(daily_return_ratio),
      max_drawdown_ratio = VALUES(max_drawdown_ratio),
      peak_equity = VALUES(peak_equity),
      benchmark_code = VALUES(benchmark_code),
      benchmark_close = VALUES(benchmark_close),
      risk_rejections = VALUES(risk_rejections),
      rule_version = VALUES(rule_version),
      created_at = VALUES(created_at)`,
    [
      id,
      snapshot.accountId,
      snapshot.tradeDate,
      snapshot.cashBalance,
      snapshot.frozenCash,
      snapshot.marketValue,
      snapshot.totalEquity,
      snapshot.initialCash,
      snapshot.returnRatio,
      snapshot.dailyReturnRatio,
      snapshot.maxDrawdownRatio,
      snapshot.peakEquity,
      snapshot.benchmarkCode,
      snapshot.benchmarkClose,
      snapshot.riskRejections,
      snapshot.ruleVersion,
      now,
    ],
  );
  return now;
}

export async function recordAllPaperEquitySnapshots(
  pool: mysql.Pool,
  tradeDate: string,
  options?: { benchmarkCode?: string | null; benchmarkClose?: number | null },
): Promise<EquitySnapshotSummary[]> {
  const [rows] = await pool.execute<AccountRow[]>(
    'SELECT id FROM paper_accounts ORDER BY created_at',
  );
  const snapshots: EquitySnapshotSummary[] = [];
  for (const row of rows) {
    snapshots.push(
      await recordPaperEquitySnapshot(pool, row.id, tradeDate, options),
    );
  }
  return snapshots;
}

async function fetchPreviousSnapshot(
  pool: mysql.Pool,
  accountId: string,
  tradeDate: string,
): Promise<EquitySnapshotSummary | null> {
  const [rows] = await pool.execute<SnapshotRow[]>(
    `SELECT * FROM paper_equity_snapshots
     WHERE account_id = ? AND trade_date < ?
     ORDER BY trade_date DESC LIMIT 1`,
    [accountId, tradeDate],
  );
  return rows[0] ? mapSnapshot(rows[0]) : null;
}

export async function listPaperEquitySnapshots(
  pool: mysql.Pool,
  accountId: string,
  options?: { limit?: number },
): Promise<EquitySnapshotSummary[]> {
  const limit = Math.max(1, Math.min(1000, options?.limit ?? 365));
  const [rows] = await pool.execute<SnapshotRow[]>(
    `SELECT * FROM paper_equity_snapshots
     WHERE account_id = ?
     ORDER BY trade_date DESC
     LIMIT ?`,
    [accountId, limit],
  );
  return rows.map(mapSnapshot);
}

export async function getLatestPaperEquitySnapshot(
  pool: mysql.Pool,
  accountId: string,
): Promise<EquitySnapshotSummary | null> {
  const [rows] = await pool.execute<SnapshotRow[]>(
    `SELECT * FROM paper_equity_snapshots
     WHERE account_id = ?
     ORDER BY trade_date DESC LIMIT 1`,
    [accountId],
  );
  return rows[0] ? mapSnapshot(rows[0]) : null;
}

function mapSnapshot(row: SnapshotRow): EquitySnapshotSummary {
  return {
    accountId: row.account_id,
    tradeDate: String(row.trade_date).slice(0, 10),
    cashBalance: Number(row.cash_balance),
    frozenCash: Number(row.frozen_cash),
    marketValue: Number(row.market_value),
    totalEquity: Number(row.total_equity),
    initialCash: Number(row.initial_cash),
    returnRatio: Number(row.return_ratio),
    dailyReturnRatio: row.daily_return_ratio == null
      ? null
      : Number(row.daily_return_ratio),
    maxDrawdownRatio: row.max_drawdown_ratio == null
      ? null
      : Number(row.max_drawdown_ratio),
    peakEquity: row.peak_equity == null ? null : Number(row.peak_equity),
    benchmarkCode: row.benchmark_code,
    benchmarkClose: row.benchmark_close == null
      ? null
      : Number(row.benchmark_close),
    riskRejections: Number(row.risk_rejections),
    ruleVersion: row.rule_version,
    createdAt: row.created_at,
  };
}

function mysqlDateTime(value = new Date()) {
  return value.toISOString().slice(0, 23).replace('T', ' ');
}
