import type mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { roundMoney } from '../../../shared/trading-rules/index.js';

/**
 * 对账聚合输入 —— 由 DB 查询聚合后传入，便于纯函数测试。
 *
 * 守恒不变量：
 * 1. `paper_accounts.cash_balance` 必须等于 `paper_cash_ledger.amount` 的代数和；
 * 2. `paper_accounts.frozen_cash` 必须等于最近一条流水的 `frozen_after`；
 * 3. `paper_positions.total_quantity` 必须等于 `paper_position_lots.quantity` 之和；
 * 4. `paper_positions.available_quantity + frozen_quantity`
 *    必须等于 `paper_position_lots.available_quantity` 之和。
 *
 * 上述 4 条直接对应 Phase 1 验收「资金流水汇总与账户余额完全一致」
 * 与「持仓批次汇总与持仓总表完全一致」两项要求。
 */
export interface AccountReconciliationData {
  account: {
    id: string;
    name: string;
    cashBalance: number;
    frozenCash: number;
  };
  ledger: {
    balanceDeltaSum: number;
    latestFrozenAfter: number | null;
  };
  positions: Array<{
    instrumentKey: number;
    securityCode: string;
    securityName: string;
    totalQuantity: number;
    availableQuantity: number;
    frozenQuantity: number;
  }>;
  lotSums: Array<{
    instrumentKey: number;
    quantitySum: number;
    availableSum: number;
  }>;
}

export interface ReconciliationLineCheck {
  expected: number;
  actual: number;
  diff: number;
  ok: boolean;
}

export interface PositionReconciliation {
  instrumentKey: number;
  securityCode: string;
  securityName: string;
  totalQuantity: ReconciliationLineCheck;
  available: ReconciliationLineCheck;
  ok: boolean;
}

export interface ReconciliationResult {
  accountId: string;
  accountName: string;
  cash: ReconciliationLineCheck;
  frozen: ReconciliationLineCheck;
  positions: PositionReconciliation[];
  ok: boolean;
}

/** 浮点对账容差：DECIMAL(20,4) → number 时的舍入误差上限。 */
export const RECONCILIATION_TOLERANCE = 0.005;

export function reconcilePaperAccountState(
  input: AccountReconciliationData,
): ReconciliationResult {
  const cashExpected = roundMoney(input.ledger.balanceDeltaSum);
  const cashActual = roundMoney(input.account.cashBalance);
  const cashDiff = roundMoney(cashActual - cashExpected);
  const cash: ReconciliationLineCheck = {
    expected: cashExpected,
    actual: cashActual,
    diff: cashDiff,
    ok: Math.abs(cashDiff) <= RECONCILIATION_TOLERANCE,
  };

  const frozenExpected = input.ledger.latestFrozenAfter == null
    ? 0
    : roundMoney(input.ledger.latestFrozenAfter);
  const frozenActual = roundMoney(input.account.frozenCash);
  const frozenDiff = roundMoney(frozenActual - frozenExpected);
  const frozen: ReconciliationLineCheck = {
    expected: frozenExpected,
    actual: frozenActual,
    diff: frozenDiff,
    ok: Math.abs(frozenDiff) <= RECONCILIATION_TOLERANCE,
  };

  const positions: PositionReconciliation[] = input.positions.map((position) => {
    const lotSum = input.lotSums.find(
      (item) => item.instrumentKey === position.instrumentKey,
    ) ?? { instrumentKey: position.instrumentKey, quantitySum: 0, availableSum: 0 };
    const expectedTotal = roundMoney(lotSum.quantitySum);
    const actualTotal = roundMoney(position.totalQuantity);
    const totalDiff = roundMoney(actualTotal - expectedTotal);
    const totalQuantity: ReconciliationLineCheck = {
      expected: expectedTotal,
      actual: actualTotal,
      diff: totalDiff,
      ok: Math.abs(totalDiff) <= RECONCILIATION_TOLERANCE,
    };
    const expectedAvailable = roundMoney(lotSum.availableSum);
    const actualAvailable = roundMoney(
      position.availableQuantity + position.frozenQuantity,
    );
    const availableDiff = roundMoney(actualAvailable - expectedAvailable);
    const available: ReconciliationLineCheck = {
      expected: expectedAvailable,
      actual: actualAvailable,
      diff: availableDiff,
      ok: Math.abs(availableDiff) <= RECONCILIATION_TOLERANCE,
    };
    return {
      instrumentKey: position.instrumentKey,
      securityCode: position.securityCode,
      securityName: position.securityName,
      totalQuantity,
      available,
      ok: totalQuantity.ok && available.ok,
    };
  });

  return {
    accountId: input.account.id,
    accountName: input.account.name,
    cash,
    frozen,
    positions,
    ok: cash.ok && frozen.ok && positions.every((item) => item.ok),
  };
}

interface AccountRow extends RowDataPacket {
  id: string;
  name: string;
  cash_balance: string | number;
  frozen_cash: string | number;
}

interface LedgerAggregateRow extends RowDataPacket {
  balance_delta_sum: string | number | null;
  latest_frozen_after: string | number | null;
}

interface PositionAggregateRow extends RowDataPacket {
  instrument_key: number;
  quantity_sum: string | number | null;
  available_sum: string | number | null;
}

interface PositionRow extends RowDataPacket {
  instrument_key: number;
  security_code: string;
  security_name: string;
  total_quantity: string | number;
  available_quantity: string | number;
  frozen_quantity: string | number;
}

export async function reconcilePaperAccount(
  pool: mysql.Pool,
  accountId: string,
): Promise<ReconciliationResult> {
  const [accounts] = await pool.execute<AccountRow[]>(
    'SELECT id, name, cash_balance, frozen_cash FROM paper_accounts WHERE id = ? LIMIT 1',
    [accountId],
  );
  const accountRow = accounts[0];
  if (!accountRow) {
    throw new Error(`模拟账户不存在：${accountId}`);
  }
  return reconcilePaperAccountState({
    account: {
      id: accountRow.id,
      name: accountRow.name,
      cashBalance: Number(accountRow.cash_balance),
      frozenCash: Number(accountRow.frozen_cash),
    },
    ledger: await fetchLedgerAggregate(pool, accountId),
    positions: await fetchPositions(pool, accountId),
    lotSums: await fetchLotSums(pool, accountId),
  });
}

export async function reconcileAllPaperAccounts(
  pool: mysql.Pool,
): Promise<ReconciliationResult[]> {
  const [rows] = await pool.execute<AccountRow[]>(
    'SELECT id, name, cash_balance, frozen_cash FROM paper_accounts ORDER BY created_at',
  );
  const results: ReconciliationResult[] = [];
  for (const row of rows) {
    results.push(await reconcilePaperAccount(pool, row.id));
  }
  return results;
}

async function fetchLedgerAggregate(
  pool: mysql.Pool,
  accountId: string,
): Promise<AccountReconciliationData['ledger']> {
  const [rows] = await pool.execute<LedgerAggregateRow[]>(
    `SELECT
       COALESCE(SUM(amount), 0) AS balance_delta_sum,
       (SELECT frozen_after FROM paper_cash_ledger
        WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_frozen_after
     FROM paper_cash_ledger WHERE account_id = ?`,
    [accountId, accountId],
  );
  const row = rows[0] ?? { balance_delta_sum: 0, latest_frozen_after: null };
  return {
    balanceDeltaSum: Number(row.balance_delta_sum ?? 0),
    latestFrozenAfter: row.latest_frozen_after == null
      ? null
      : Number(row.latest_frozen_after),
  };
}

async function fetchPositions(
  pool: mysql.Pool,
  accountId: string,
): Promise<AccountReconciliationData['positions']> {
  const [rows] = await pool.execute<PositionRow[]>(
    `SELECT instrument_key, security_code, security_name,
            total_quantity, available_quantity, frozen_quantity
     FROM paper_positions WHERE account_id = ? AND total_quantity > 0
     ORDER BY instrument_key`,
    [accountId],
  );
  return rows.map((row) => ({
    instrumentKey: Number(row.instrument_key),
    securityCode: String(row.security_code),
    securityName: String(row.security_name),
    totalQuantity: Number(row.total_quantity),
    availableQuantity: Number(row.available_quantity),
    frozenQuantity: Number(row.frozen_quantity),
  }));
}

async function fetchLotSums(
  pool: mysql.Pool,
  accountId: string,
): Promise<AccountReconciliationData['lotSums']> {
  const [rows] = await pool.execute<PositionAggregateRow[]>(
    `SELECT instrument_key,
            COALESCE(SUM(quantity), 0) AS quantity_sum,
            COALESCE(SUM(available_quantity), 0) AS available_sum
     FROM paper_position_lots WHERE account_id = ?
     GROUP BY instrument_key
     ORDER BY instrument_key`,
    [accountId],
  );
  return rows.map((row) => ({
    instrumentKey: Number(row.instrument_key),
    quantitySum: Number(row.quantity_sum ?? 0),
    availableSum: Number(row.available_sum ?? 0),
  }));
}

/**
 * 将对账结果转换为可读的多行文本，便于审计日志与诊断输出。
 */
export function formatReconciliationResult(result: ReconciliationResult): string[] {
  const lines: string[] = [];
  lines.push(
    `[Reconcile] account=${result.accountName}(${result.accountId}) ok=${result.ok}`,
  );
  lines.push(
    `  cash expected=${result.cash.expected.toFixed(4)} actual=${result.cash.actual.toFixed(4)} diff=${result.cash.diff.toFixed(4)} ok=${result.cash.ok}`,
  );
  lines.push(
    `  frozen expected=${result.frozen.expected.toFixed(4)} actual=${result.frozen.actual.toFixed(4)} diff=${result.frozen.diff.toFixed(4)} ok=${result.frozen.ok}`,
  );
  for (const position of result.positions) {
    lines.push(
      `  position ${position.securityCode} total=${position.totalQuantity.actual}/${position.totalQuantity.expected} diff=${position.totalQuantity.diff} available=${position.available.actual}/${position.available.expected} diff=${position.available.diff} ok=${position.ok}`,
    );
  }
  return lines;
}
