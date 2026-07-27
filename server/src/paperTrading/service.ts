import type mysql from 'mysql2/promise';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { fetchStockQuote } from '../marketData/aStockDataService.js';
import { queryMinuteBars } from '../minuteData/minuteDataService.js';
import { getChinaMarketSession } from '../marketData/jobs/marketSession.js';
import {
  TRADING_RULES_VERSION,
  applySlippage,
  evaluateAshareTradability,
  normalizeStockBuyQuantity,
  normalizeStockSellQuantity,
  roundMoney,
  roundPrice,
} from '../../../shared/trading-rules/index.js';
import type {
  PaperOrderSide,
  PaperOrderStatus,
  PaperOrderType,
} from './domain.js';
import {
  calculateBuyReservation,
  calculateBuySettlement,
  calculateQuickOrderQuantities,
  calculateSellSettlement,
} from './accounting.js';
import {
  evaluatePaperRisk,
  getPaperRiskConfig,
  insertRiskEvent,
  type RiskEvaluationContext,
} from './riskControl.js';

export class PaperTradingError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'PaperTradingError';
  }
}

export interface CreatePaperAccountInput {
  name: string;
  initialCash: number;
  commissionRate?: number;
  minimumCommission?: number;
  sellTaxRate?: number;
  slippageBps?: number;
}

export interface SubmitPaperOrderInput {
  accountId: string;
  clientOrderId: string;
  securityCode: string;
  side: PaperOrderSide;
  orderType: PaperOrderType;
  quantity: number;
  limitPrice?: number | null;
}

export interface PreviewPaperOrderInput {
  accountId: string;
  securityQuery: string;
  side: PaperOrderSide;
  orderType: PaperOrderType;
  limitPrice?: number | null;
}

interface InstrumentRow extends RowDataPacket {
  instrument_key: number;
  symbol: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  status: 'pending' | 'active' | 'suspended' | 'delisted';
  list_date: string | null;
}

interface AccountRow extends RowDataPacket {
  id: string;
  name: string;
  initial_cash: string;
  cash_balance: string;
  frozen_cash: string;
  commission_rate: string;
  minimum_commission: string;
  sell_tax_rate: string;
  slippage_bps: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface OrderRow extends RowDataPacket {
  id: string;
  account_id: string;
  instrument_key: number;
  client_order_id: string;
  security_code: string;
  security_name: string;
  market: 'SH' | 'SZ' | 'BJ';
  side: PaperOrderSide;
  order_type: PaperOrderType;
  time_in_force: 'day';
  quantity: string;
  limit_price: string | null;
  status: PaperOrderStatus;
  filled_quantity: string;
  average_fill_price: string | null;
  frozen_cash: string;
  frozen_quantity: string;
  reject_code: string | null;
  reject_reason: string | null;
  rule_version: string;
  submitted_at: string;
  updated_at: string;
}

interface PositionRow extends RowDataPacket {
  account_id: string;
  instrument_key: number;
  security_code: string;
  security_name: string;
  market: string;
  total_quantity: string;
  available_quantity: string;
  frozen_quantity: string;
  average_cost: string;
  last_price: string | null;
  market_value: string;
  realized_pnl: string;
  updated_at: string;
}

interface PaperMarketQuote {
  price: number;
  previousClose: number | null;
  volume: number | null;
  quoteTime: string;
  source: string;
}

const DEFAULT_COMMISSION_RATE = 0.0003;
const DEFAULT_MINIMUM_COMMISSION = 5;
// The 2023 policy halves the former 0.1% sell-side stamp duty.
const DEFAULT_SELL_TAX_RATE = 0.0005;
const DEFAULT_SLIPPAGE_BPS = 1;
const ACTIVE_ORDER_STATUSES: PaperOrderStatus[] = ['accepted', 'partially_filled'];

export async function createPaperAccount(
  pool: mysql.Pool,
  input: CreatePaperAccountInput,
) {
  const name = input.name.trim();
  if (!name) throw new PaperTradingError('INVALID_ACCOUNT_NAME', '账户名称不能为空');
  if (!Number.isFinite(input.initialCash) || input.initialCash <= 0) {
    throw new PaperTradingError('INVALID_INITIAL_CASH', '初始资金必须大于 0');
  }
  const id = crypto.randomUUID();
  const now = mysqlDateTime();
  const initialCash = roundMoney(input.initialCash);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO paper_accounts (
        id, name, initial_cash, cash_balance, frozen_cash,
        commission_rate, minimum_commission, sell_tax_rate, slippage_bps,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        name,
        initialCash,
        initialCash,
        input.commissionRate ?? DEFAULT_COMMISSION_RATE,
        input.minimumCommission ?? DEFAULT_MINIMUM_COMMISSION,
        input.sellTaxRate ?? DEFAULT_SELL_TAX_RATE,
        input.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
        now,
        now,
      ],
    );
    await connection.execute(
      `INSERT INTO paper_cash_ledger (
        id, account_id, event_type, amount, balance_after, frozen_after,
        description, created_at
      ) VALUES (?, ?, 'initial_deposit', ?, ?, 0, '模拟账户初始入金', ?)`,
      [crypto.randomUUID(), id, initialCash, initialCash, now],
    );
    await insertAudit(connection, id, null, 'account_created', {
      initialCash,
      ruleVersion: TRADING_RULES_VERSION,
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return getPaperAccount(pool, id);
}

export async function listPaperAccounts(pool: mysql.Pool) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.*,
      COALESCE(SUM(p.market_value), 0) AS market_value,
      a.cash_balance + COALESCE(SUM(p.market_value), 0) AS total_equity
     FROM paper_accounts a
     LEFT JOIN paper_positions p
       ON p.account_id = a.id AND p.total_quantity > 0
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
  );
  return rows.map(mapAccountSummary);
}

export async function deletePaperAccount(pool: mysql.Pool, accountId: string) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const account = await lockAccount(connection, accountId);
    const [runRows] = await connection.execute<RowDataPacket[]>(
      `SELECT DISTINCT execution_run_id AS id
       FROM paper_trades
       WHERE account_id = ?`,
      [accountId],
    );
    const [optionalRows] = await connection.execute<RowDataPacket[]>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (
           'paper_risk_events',
           'paper_equity_snapshots',
           'paper_strategy_bindings',
           'paper_risk_configs'
         )`,
    );
    const optionalTables = new Set(optionalRows.map((row) => String(row.table_name)));
    for (const table of [
      'paper_risk_events',
      'paper_equity_snapshots',
      'paper_strategy_bindings',
      'paper_risk_configs',
    ]) {
      if (optionalTables.has(table)) {
        await connection.execute(`DELETE FROM ${table} WHERE account_id = ?`, [accountId]);
      }
    }
    for (const table of [
      'paper_audit_logs',
      'paper_cash_ledger',
      'paper_trades',
      'paper_position_lots',
      'paper_positions',
      'paper_orders',
    ]) {
      await connection.execute(`DELETE FROM ${table} WHERE account_id = ?`, [accountId]);
    }
    const executionRunIds = runRows.map((row) => String(row.id)).filter(Boolean);
    if (executionRunIds.length > 0) {
      await connection.query(
        'DELETE FROM paper_execution_runs WHERE id IN (?)',
        [executionRunIds],
      );
    }
    await connection.execute('DELETE FROM paper_accounts WHERE id = ?', [accountId]);
    await connection.commit();
    return {
      deleted: true,
      accountId,
      accountName: account.name,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getPaperAccount(pool: mysql.Pool, accountId: string) {
  await settlePaperPositionsT1(pool, getChinaMarketSession().tradeDate);
  const [accounts] = await pool.execute<AccountRow[]>(
    'SELECT * FROM paper_accounts WHERE id = ? LIMIT 1',
    [accountId],
  );
  const account = accounts[0];
  if (!account) {
    throw new PaperTradingError('ACCOUNT_NOT_FOUND', '模拟账户不存在', 404);
  }
  const [positions, orders, trades, ledger] = await Promise.all([
    pool.execute<PositionRow[]>(
      `SELECT * FROM paper_positions
       WHERE account_id = ? AND total_quantity > 0
       ORDER BY market_value DESC, security_code`,
      [accountId],
    ).then(([rows]) => rows.map(mapPosition)),
    pool.execute<OrderRow[]>(
      `SELECT * FROM paper_orders WHERE account_id = ?
       ORDER BY submitted_at DESC LIMIT 200`,
      [accountId],
    ).then(([rows]) => rows.map(mapOrder)),
    pool.execute<RowDataPacket[]>(
      `SELECT t.*, o.security_code, o.security_name, o.market
       FROM paper_trades t
       JOIN paper_orders o ON o.id = t.order_id
       WHERE t.account_id = ? ORDER BY t.created_at DESC LIMIT 200`,
      [accountId],
    ).then(([rows]) => rows.map(mapNumericRow)),
    pool.execute<RowDataPacket[]>(
      `SELECT * FROM paper_cash_ledger WHERE account_id = ?
       ORDER BY created_at DESC LIMIT 200`,
      [accountId],
    ).then(([rows]) => rows.map(mapNumericRow)),
  ]);
  const marketValue = positions.reduce((sum, position) => sum + position.marketValue, 0);
  const cashBalance = number(account.cash_balance);
  const frozenCash = number(account.frozen_cash);
  return {
    ...mapAccount(account),
    availableCash: roundMoney(cashBalance - frozenCash),
    marketValue: roundMoney(marketValue),
    totalEquity: roundMoney(cashBalance + marketValue),
    positions,
    orders,
    trades,
    ledger,
  };
}

export async function previewPaperOrder(
  pool: mysql.Pool,
  minuteDataRoot: string,
  input: PreviewPaperOrderInput,
) {
  const [accounts] = await pool.execute<AccountRow[]>(
    'SELECT * FROM paper_accounts WHERE id = ? LIMIT 1',
    [input.accountId],
  );
  const account = accounts[0];
  if (!account) {
    throw new PaperTradingError('ACCOUNT_NOT_FOUND', '模拟账户不存在', 404);
  }
  const instrument = await resolveInstrument(pool, input.securityQuery);
  const quote = await resolvePaperMarketQuote(
    pool,
    minuteDataRoot,
    instrument.symbol,
    instrument.instrument_key,
  );
  const [positions] = await pool.execute<PositionRow[]>(
    `SELECT * FROM paper_positions
     WHERE account_id = ? AND instrument_key = ?
     LIMIT 1`,
    [input.accountId, instrument.instrument_key],
  );
  const position = positions[0];
  const availableCash = roundMoney(number(account.cash_balance) - number(account.frozen_cash));
  const estimatedPrice = input.orderType === 'limit' && input.limitPrice
    ? input.limitPrice
    : applySlippage(quote.price, input.side, number(account.slippage_bps));
  const quickQuantities = calculateQuickOrderQuantities({
    side: input.side,
    availableCash,
    availableQuantity: number(position?.available_quantity),
    estimatedPrice,
    fees: {
      commissionRate: number(account.commission_rate),
      minimumCommission: number(account.minimum_commission),
      sellTaxRate: number(account.sell_tax_rate),
    },
  });
  return {
    instrument: {
      instrumentKey: instrument.instrument_key,
      securityCode: instrument.symbol,
      securityName: instrument.name,
      market: instrument.market,
    },
    quote: {
      price: quote.price,
      quoteTime: quote.quoteTime,
      source: quote.source,
    },
    lotSize: 100,
    availableCash,
    availableQuantity: number(position?.available_quantity),
    estimatedPrice: roundPrice(estimatedPrice),
    quickQuantities,
  };
}

export async function submitPaperOrder(
  pool: mysql.Pool,
  minuteDataRoot: string,
  input: SubmitPaperOrderInput,
) {
  validateOrderDraft(input);
  await settlePaperPositionsT1(pool, getChinaMarketSession().tradeDate);
  const existing = await findOrderByClientId(pool, input.accountId, input.clientOrderId);
  if (existing) return { order: mapOrder(existing), idempotent: true, matched: false };

  const instrument = await resolveInstrument(pool, input.securityCode);
  const quote = await resolvePaperMarketQuote(
    pool,
    minuteDataRoot,
    instrument.symbol,
    instrument.instrument_key,
  );
  const session = getChinaMarketSession();
  const tradingDayNumber = await countTradingDays(
    pool,
    instrument.instrument_key,
    instrument.list_date,
    session.tradeDate,
  );
  const limitPrice = input.orderType === 'limit' ? Number(input.limitPrice) : null;
  const marketPhase = mapMarketPhase(session.phase);
  const tradability = evaluateAshareTradability({
    securityCode: instrument.symbol,
    listDate: instrument.list_date,
    tradeDate: session.tradeDate,
    tradingDayNumber,
    isRiskWarning: isRiskWarningName(instrument.name),
    securityStatus: instrument.status,
    marketPhase,
    previousClose: quote.previousClose,
    orderPrice: limitPrice,
  });
  if (!tradability.tradable && tradability.reasonCode !== 'market_closed') {
    throw new PaperTradingError(
      tradability.reasonCode ?? 'NOT_TRADABLE',
      tradability.reason ?? '证券当前不可交易',
    );
  }

  const requestedQuantity = input.side === 'buy'
    ? normalizeStockBuyQuantity(input.quantity)
    : input.quantity;
  if (requestedQuantity <= 0) {
    throw new PaperTradingError('INVALID_QUANTITY', '买入或委托数量必须至少为一手（100 股）');
  }
  // Risk evaluation uses the limit price if available, otherwise the current
  // quote. Slippage is added inside the actual settlement step, but the risk
  // estimate deliberately ignores it so that rejected orders never freeze
  // cash for a brief window before being blocked.
  const riskEstimatePrice = limitPrice ?? quote.price;
  const riskConfig = await getPaperRiskConfig(pool, input.accountId);
  if (riskConfig) {
    const riskContext = await gatherRiskEvaluationContext(
      pool,
      input.accountId,
      instrument.instrument_key,
      input.side,
      instrument.symbol,
      requestedQuantity,
      riskEstimatePrice,
      session.tradeDate,
    );
    const riskResult = evaluatePaperRisk(riskConfig, riskContext);
    if (!riskResult.passed) {
      await insertRiskEvent(pool, input.accountId, null, riskResult);
      throw new PaperTradingError(
        'RISK_REJECTED',
        riskResult.violations.map((v) => v.reason).join('; '),
        409,
        { violations: riskResult.violations },
      );
    }
  }
  const orderId = crypto.randomUUID();
  const now = mysqlDateTime();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const account = await lockAccount(connection, input.accountId);
    if (account.status !== 'active') {
      throw new PaperTradingError('ACCOUNT_NOT_ACTIVE', '模拟账户当前不可交易');
    }
    const duplicate = await findOrderByClientId(connection, input.accountId, input.clientOrderId);
    if (duplicate) {
      await connection.rollback();
      return { order: mapOrder(duplicate), idempotent: true, matched: false };
    }

    let frozenCash = 0;
    let frozenQuantity = 0;
    let quantity = requestedQuantity;
    if (input.side === 'buy') {
      const estimatePrice = limitPrice ?? applySlippage(
        quote.price,
        'buy',
        number(account.slippage_bps),
      );
      frozenCash = calculateBuyReservation(quantity, estimatePrice, {
        commissionRate: number(account.commission_rate),
        minimumCommission: number(account.minimum_commission),
        sellTaxRate: number(account.sell_tax_rate),
      }).frozenCash;
      const availableCash = number(account.cash_balance) - number(account.frozen_cash);
      if (frozenCash > availableCash) {
        throw new PaperTradingError(
          'INSUFFICIENT_CASH',
          `可用资金不足，需要 ${frozenCash.toFixed(2)} 元`,
          409,
        );
      }
      await connection.execute(
        `UPDATE paper_accounts
         SET frozen_cash = frozen_cash + ?, updated_at = ? WHERE id = ?`,
        [frozenCash, now, input.accountId],
      );
    } else {
      const position = await lockPosition(
        connection,
        input.accountId,
        instrument.instrument_key,
      );
      if (!position) {
        throw new PaperTradingError('POSITION_NOT_FOUND', '没有可卖持仓', 409);
      }
      quantity = normalizeStockSellQuantity(
        input.quantity,
        number(position.available_quantity),
      );
      if (quantity <= 0 || quantity > number(position.available_quantity)) {
        throw new PaperTradingError('INSUFFICIENT_AVAILABLE_POSITION', 'T+1 可卖持仓不足', 409);
      }
      frozenQuantity = quantity;
      await connection.execute(
        `UPDATE paper_positions
         SET available_quantity = available_quantity - ?,
             frozen_quantity = frozen_quantity + ?,
             updated_at = ?
         WHERE account_id = ? AND instrument_key = ?`,
        [quantity, quantity, now, input.accountId, instrument.instrument_key],
      );
    }

    await connection.execute(
      `INSERT INTO paper_orders (
        id, account_id, instrument_key, client_order_id,
        security_code, security_name, market, side, order_type, time_in_force,
        quantity, limit_price, status, filled_quantity, average_fill_price,
        frozen_cash, frozen_quantity, rule_version, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'day', ?, ?, 'accepted', 0, NULL, ?, ?, ?, ?, ?)`,
      [
        orderId,
        input.accountId,
        instrument.instrument_key,
        input.clientOrderId,
        instrument.symbol,
        instrument.name,
        instrument.market,
        input.side,
        input.orderType,
        quantity,
        limitPrice,
        frozenCash,
        frozenQuantity,
        TRADING_RULES_VERSION,
        now,
        now,
      ],
    );
    if (input.side === 'buy') {
      await insertCashLedger(
        connection,
        input.accountId,
        orderId,
        null,
        'order_freeze',
        0,
        number(account.cash_balance),
        number(account.frozen_cash) + frozenCash,
        `${instrument.symbol} 买入委托冻结资金`,
        now,
      );
    }
    await insertAudit(connection, input.accountId, orderId, 'order_accepted', {
      side: input.side,
      orderType: input.orderType,
      quantity,
      limitPrice,
      frozenCash,
      frozenQuantity,
      quoteSource: quote.source,
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    if (isDuplicateKey(error)) {
      const duplicate = await findOrderByClientId(pool, input.accountId, input.clientOrderId);
      if (duplicate) return { order: mapOrder(duplicate), idempotent: true, matched: false };
    }
    throw error;
  } finally {
    connection.release();
  }

  let matchResult: { matched: boolean; order: ReturnType<typeof mapOrder> };
  if (session.isIntradayUpdateWindow) {
    matchResult = await matchPaperOrder(pool, minuteDataRoot, orderId);
  } else {
    const created = await getPaperOrder(pool, orderId);
    matchResult = { matched: false, order: created };
  }
  return { ...matchResult, idempotent: false };
}

export async function cancelPaperOrder(
  pool: mysql.Pool,
  accountId: string,
  orderId: string,
) {
  const connection = await pool.getConnection();
  const now = mysqlDateTime();
  try {
    await connection.beginTransaction();
    const order = await lockOrder(connection, orderId);
    if (!order || order.account_id !== accountId) {
      throw new PaperTradingError('ORDER_NOT_FOUND', '模拟委托不存在', 404);
    }
    if (!ACTIVE_ORDER_STATUSES.includes(order.status)) {
      throw new PaperTradingError('ORDER_NOT_CANCELLABLE', '当前委托状态不可撤销', 409);
    }
    const account = await lockAccount(connection, accountId);
    await releaseOrderFreeze(connection, order, now);
    if (order.side === 'buy' && number(order.frozen_cash) > 0) {
      await insertCashLedger(
        connection,
        accountId,
        orderId,
        null,
        'order_unfreeze',
        0,
        number(account.cash_balance),
        Math.max(0, number(account.frozen_cash) - number(order.frozen_cash)),
        `${order.security_code} 撤单释放冻结资金`,
        now,
      );
    }
    await connection.execute(
      `UPDATE paper_orders
       SET status = 'cancelled', frozen_cash = 0, frozen_quantity = 0, updated_at = ?
       WHERE id = ?`,
      [now, orderId],
    );
    await insertAudit(connection, accountId, orderId, 'order_cancelled', {});
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return getPaperOrder(pool, orderId);
}

export async function matchPaperOrder(
  pool: mysql.Pool,
  minuteDataRoot: string,
  orderId: string,
) {
  const preview = await getPaperOrderRow(pool, orderId);
  if (!preview) throw new PaperTradingError('ORDER_NOT_FOUND', '模拟委托不存在', 404);
  if (!ACTIVE_ORDER_STATUSES.includes(preview.status)) {
    return { matched: false, order: mapOrder(preview) };
  }
  const session = getChinaMarketSession();
  if (!session.isIntradayUpdateWindow) {
    return { matched: false, order: mapOrder(preview) };
  }
  const quote = await resolvePaperMarketQuote(
    pool,
    minuteDataRoot,
    preview.security_code,
    preview.instrument_key,
  );
  const limitPrice = nullableNumber(preview.limit_price);
  if (
    preview.order_type === 'limit'
    && (
      (preview.side === 'buy' && quote.price > (limitPrice ?? 0))
      || (preview.side === 'sell' && quote.price < (limitPrice ?? Number.POSITIVE_INFINITY))
    )
  ) {
    return { matched: false, order: mapOrder(preview) };
  }

  const connection = await pool.getConnection();
  const executionRunId = crypto.randomUUID();
  const now = mysqlDateTime();
  try {
    await connection.beginTransaction();
    const order = await lockOrder(connection, orderId);
    if (!order || !ACTIVE_ORDER_STATUSES.includes(order.status)) {
      await connection.rollback();
      return { matched: false, order: order ? mapOrder(order) : mapOrder(preview) };
    }
    const account = await lockAccount(connection, order.account_id);
    const remaining = number(order.quantity) - number(order.filled_quantity);
    const volumeCapacity = quote.volume == null
      ? remaining
      : normalizeStockBuyQuantity(quote.volume * 0.1);
    const fillQuantity = Math.min(remaining, volumeCapacity);
    if (fillQuantity <= 0) {
      await connection.rollback();
      return { matched: false, order: mapOrder(order) };
    }

    const slippedPrice = applySlippage(
      quote.price,
      order.side,
      number(account.slippage_bps),
    );
    const fillPrice = roundPrice(order.order_type === 'limit' && limitPrice != null
      ? order.side === 'buy'
        ? Math.min(slippedPrice, limitPrice)
        : Math.max(slippedPrice, limitPrice)
      : slippedPrice);
    const feeConfig = {
      commissionRate: number(account.commission_rate),
      minimumCommission: number(account.minimum_commission),
      sellTaxRate: number(account.sell_tax_rate),
    };
    const buySettlement = order.side === 'buy'
      ? calculateBuySettlement(fillQuantity, fillPrice, feeConfig)
      : null;
    const positionForSell = order.side === 'sell'
      ? await lockPosition(connection, order.account_id, order.instrument_key)
      : null;
    const sellSettlement = order.side === 'sell' && positionForSell
      ? calculateSellSettlement(
        fillQuantity,
        fillPrice,
        number(positionForSell.average_cost),
        feeConfig,
      )
      : null;
    const amount = buySettlement?.amount ?? sellSettlement?.amount ?? 0;
    const commission = buySettlement?.commission ?? sellSettlement?.commission ?? 0;
    const tax = sellSettlement?.tax ?? 0;
    const isFilled = fillQuantity >= remaining;
    const nextStatus: PaperOrderStatus = isFilled ? 'filled' : 'partially_filled';
    const previousFilled = number(order.filled_quantity);
    const nextFilled = previousFilled + fillQuantity;
    const previousAverage = nullableNumber(order.average_fill_price) ?? 0;
    const averageFillPrice = roundPrice(
      (previousAverage * previousFilled + fillPrice * fillQuantity) / nextFilled,
    );
    const tradeId = crypto.randomUUID();
    const [sequenceRows] = await connection.query<RowDataPacket[]>(
      `SELECT COALESCE(MAX(fill_sequence), 0) + 1 AS next_sequence
       FROM paper_trades
       WHERE order_id = ?`,
      [order.id],
    );
    const fillSequence = Math.max(1, Math.trunc(number(sequenceRows[0]?.next_sequence)));

    if (order.side === 'buy') {
      const estimatedRelease = isFilled
        ? number(order.frozen_cash)
        : roundMoney(number(order.frozen_cash) * (fillQuantity / remaining));
      const totalCost = -(buySettlement?.cashChange ?? 0);
      const spendable = number(account.cash_balance)
        - number(account.frozen_cash)
        + estimatedRelease;
      if (totalCost > spendable) {
        throw new PaperTradingError('INSUFFICIENT_CASH_AT_FILL', '成交时可用资金不足', 409);
      }
      await connection.execute(
        `UPDATE paper_accounts
         SET cash_balance = cash_balance - ?,
             frozen_cash = GREATEST(0, frozen_cash - ?),
             updated_at = ?
         WHERE id = ?`,
        [totalCost, estimatedRelease, now, order.account_id],
      );
      await upsertBoughtPosition(
        connection,
        order,
        fillQuantity,
        fillPrice,
        commission,
        session.tradeDate,
        now,
      );
      await insertCashLedger(
        connection,
        order.account_id,
        order.id,
        tradeId,
        'buy_settlement',
        -totalCost,
        number(account.cash_balance) - totalCost,
        Math.max(0, number(account.frozen_cash) - estimatedRelease),
        `${order.security_code} 买入成交`,
        now,
      );
      order.frozen_cash = String(Math.max(0, number(order.frozen_cash) - estimatedRelease));
    } else {
      const proceeds = sellSettlement?.cashChange ?? 0;
      const position = positionForSell;
      if (!position || number(position.frozen_quantity) < fillQuantity) {
        throw new PaperTradingError('POSITION_INCONSISTENT', '冻结持仓与委托不一致', 409);
      }
      await consumeAvailableLots(
        connection,
        order.account_id,
        order.instrument_key,
        fillQuantity,
        now,
      );
      const realizedPnl = sellSettlement?.realizedPnl ?? 0;
      await connection.execute(
        `UPDATE paper_positions
         SET total_quantity = total_quantity - ?,
             frozen_quantity = frozen_quantity - ?,
             realized_pnl = realized_pnl + ?,
             last_price = ?,
             market_value = GREATEST(0, total_quantity - ?) * ?,
             average_cost = CASE WHEN total_quantity - ? <= 0 THEN 0 ELSE average_cost END,
             updated_at = ?
         WHERE account_id = ? AND instrument_key = ?`,
        [
          fillQuantity,
          fillQuantity,
          realizedPnl,
          fillPrice,
          fillQuantity,
          fillPrice,
          fillQuantity,
          now,
          order.account_id,
          order.instrument_key,
        ],
      );
      await connection.execute(
        `UPDATE paper_accounts
         SET cash_balance = cash_balance + ?, updated_at = ? WHERE id = ?`,
        [proceeds, now, order.account_id],
      );
      await insertCashLedger(
        connection,
        order.account_id,
        order.id,
        tradeId,
        'sell_settlement',
        proceeds,
        number(account.cash_balance) + proceeds,
        number(account.frozen_cash),
        `${order.security_code} 卖出成交`,
        now,
      );
      order.frozen_quantity = String(
        Math.max(0, number(order.frozen_quantity) - fillQuantity),
      );
    }

    const slippageCost = roundMoney(
      fillQuantity * Math.abs(fillPrice - quote.price),
    );
    await connection.execute(
      `INSERT INTO paper_execution_runs (
        id, run_key, trade_date, status, quote_source, started_at, completed_at
      ) VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
      [
        executionRunId,
        `manual:${orderId}:${number(order.filled_quantity)}`,
        session.tradeDate,
        quote.source,
        now,
        now,
      ],
    );
    await connection.execute(
      `INSERT INTO paper_trades (
        id, order_id, account_id, instrument_key, execution_run_id, fill_sequence,
        side, quantity, raw_price, fill_price, amount, commission, tax,
        slippage_cost, quote_time, quote_source, rule_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tradeId,
        order.id,
        order.account_id,
        order.instrument_key,
        executionRunId,
        fillSequence,
        order.side,
        fillQuantity,
        quote.price,
        fillPrice,
        amount,
        commission,
        tax,
        slippageCost,
        quote.quoteTime,
        quote.source,
        TRADING_RULES_VERSION,
        now,
      ],
    );
    await connection.execute(
      `UPDATE paper_orders
       SET status = ?, filled_quantity = ?, average_fill_price = ?,
           frozen_cash = ?, frozen_quantity = ?, updated_at = ?
       WHERE id = ?`,
      [
        nextStatus,
        nextFilled,
        averageFillPrice,
        isFilled ? 0 : number(order.frozen_cash),
        isFilled ? 0 : number(order.frozen_quantity),
        now,
        order.id,
      ],
    );
    await insertAudit(connection, order.account_id, order.id, 'order_filled', {
      tradeId,
      fillQuantity,
      fillPrice,
      status: nextStatus,
      quoteSource: quote.source,
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return { matched: true, order: await getPaperOrder(pool, orderId) };
}

export async function matchActivePaperOrders(
  pool: mysql.Pool,
  minuteDataRoot: string,
  limit = 100,
) {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id
     FROM paper_orders
     WHERE status IN ('accepted', 'partially_filled')
     ORDER BY submitted_at ASC
     LIMIT ?`,
    [safeLimit],
  );
  let matched = 0;
  const failures: Array<{ orderId: string; error: string }> = [];
  for (const row of rows) {
    const orderId = String(row.id);
    try {
      const result = await matchPaperOrder(pool, minuteDataRoot, orderId);
      if (result.matched) matched += 1;
    } catch (error) {
      failures.push({
        orderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    scanned: rows.length,
    matched,
    failures,
  };
}

export async function settlePaperPositionsT1(
  pool: mysql.Pool,
  tradeDate: string,
) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE paper_position_lots
       SET available_quantity = quantity, updated_at = ?
       WHERE trade_date < ? AND available_quantity < quantity`,
      [mysqlDateTime(), tradeDate],
    );
    await connection.execute(
      `UPDATE paper_positions p
       JOIN (
         SELECT account_id, instrument_key, SUM(available_quantity) AS available_quantity
         FROM paper_position_lots
         GROUP BY account_id, instrument_key
       ) lots
       ON lots.account_id = p.account_id AND lots.instrument_key = p.instrument_key
       SET p.available_quantity = GREATEST(
         0,
         lots.available_quantity - p.frozen_quantity
       ), p.updated_at = ?`,
      [mysqlDateTime()],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function resolvePaperMarketQuote(
  pool: mysql.Pool,
  minuteDataRoot: string,
  code: string,
  instrumentKey: number,
): Promise<PaperMarketQuote> {
  const session = getChinaMarketSession();
  try {
    const local = await queryMinuteBars(minuteDataRoot, {
      code,
      startDate: session.tradeDate,
      endDate: session.tradeDate,
      limit: 1000,
      includeZeroVolume: false,
      intervalMinutes: 1,
    });
    const latest = local.items.at(-1);
    if (latest && latest.close > 0 && latest.isTradable) {
      return {
        price: latest.close,
        previousClose: latest.previousClose,
        volume: latest.volume,
        quoteTime: normalizeQuoteTime(latest.date),
        source: 'local-minute',
      };
    }
  } catch {
    // Local minute data can be unavailable before the daily snapshot is built.
  }
  try {
    const realtime = await fetchStockQuote(code, false);
    if (realtime.price != null && realtime.price > 0) {
      return {
        price: realtime.price,
        previousClose: realtime.previousClose,
        volume: null,
        quoteTime: normalizeQuoteTime(realtime.updatedAt),
        source: realtime.source.join('+') || 'realtime-quote',
      };
    }
  } catch {
    // Fall back to the authoritative local daily history below.
  }
  const [daily] = await pool.execute<RowDataPacket[]>(
    `SELECT trade_date, close, previous_close, volume
     FROM daily_bars_v2 WHERE instrument_key = ?
     ORDER BY trade_date DESC LIMIT 1`,
    [instrumentKey],
  );
  const latest = daily[0];
  if (!latest || number(latest.close) <= 0) {
    throw new PaperTradingError('QUOTE_UNAVAILABLE', '没有可用于模拟委托的可靠行情', 503);
  }
  return {
    price: number(latest.close),
    previousClose: nullableNumber(latest.previous_close),
    volume: nullableNumber(latest.volume),
    quoteTime: `${String(latest.trade_date).slice(0, 10)} 15:00:00.000`,
    source: 'local-daily-fallback',
  };
}

async function resolveInstrument(pool: mysql.Pool, rawValue: string): Promise<InstrumentRow> {
  const query = rawValue.trim();
  if (!query) throw new PaperTradingError('INSTRUMENT_NOT_FOUND', '请输入证券名称或代码', 404);
  const codeMatch = /^(?:(?:SH|SZ|BJ)[.:-]?)?(\d{6})$/i.exec(query);
  const code = codeMatch?.[1] ?? null;
  const [rows] = await pool.execute<InstrumentRow[]>(
    `SELECT instrument_key, symbol, name, market, status, list_date
     FROM instruments
     WHERE type = 'stock'
       AND ${code ? 'symbol = ?' : 'name = ?'}
     ORDER BY status = 'active' DESC, market, instrument_key
     LIMIT 2`,
    [code ?? query],
  );
  if (!rows[0]) {
    throw new PaperTradingError(
      'INSTRUMENT_NOT_FOUND',
      '交易标的不存在，请输入完整名称、6 位代码或从候选项选择',
      404,
    );
  }
  if (!code && rows.length > 1) {
    throw new PaperTradingError(
      'AMBIGUOUS_INSTRUMENT_NAME',
      '证券名称存在多个匹配项，请改用代码或从候选项选择',
      409,
    );
  }
  return rows[0];
}

async function countTradingDays(
  pool: mysql.Pool,
  instrumentKey: number,
  listDate: string | null,
  tradeDate: string,
): Promise<number | null> {
  if (!listDate) return null;
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM daily_bars_v2
     WHERE instrument_key = ? AND trade_date >= ? AND trade_date <= ?`,
    [instrumentKey, listDate, tradeDate],
  );
  return number(rows[0]?.count);
}

async function gatherRiskEvaluationContext(
  pool: mysql.Pool,
  accountId: string,
  instrumentKey: number,
  side: PaperOrderSide,
  securityCode: string,
  quantity: number,
  estimatePrice: number,
  tradeDate: string,
): Promise<RiskEvaluationContext> {
  const [accountRows] = await pool.execute<AccountRow[]>(
    'SELECT * FROM paper_accounts WHERE id = ? LIMIT 1',
    [accountId],
  );
  const accountRow = accountRows[0];
  if (!accountRow) {
    throw new PaperTradingError('ACCOUNT_NOT_FOUND', '模拟账户不存在', 404);
  }
  const [accountMetrics] = await pool.execute<RowDataPacket[]>(
    `SELECT
       COALESCE(SUM(market_value), 0) AS market_value,
       COALESCE(SUM(CASE WHEN instrument_key = ? THEN market_value ELSE 0 END), 0) AS security_market_value
     FROM paper_positions
     WHERE account_id = ? AND total_quantity > 0`,
    [instrumentKey, accountId],
  );
  const [todayMetrics] = await pool.execute<RowDataPacket[]>(
    `SELECT
       COUNT(*) AS order_count,
       COALESCE(SUM(t.amount), 0) AS turnover
     FROM paper_orders o
     LEFT JOIN paper_trades t
       ON t.order_id = o.id AND DATE(t.created_at) = ?
     WHERE o.account_id = ? AND DATE(o.submitted_at) = ?`,
    [tradeDate, accountId, tradeDate],
  );
  const [todayRealized] = await pool.execute<RowDataPacket[]>(
    `SELECT COALESCE(SUM(realized_pnl_change), 0) AS realized
     FROM (
       SELECT
         t.id AS trade_id,
         CASE WHEN t.side = 'sell' THEN
           (t.fill_price - p.average_cost) * t.quantity
           - t.commission - t.tax
         ELSE 0 END AS realized_pnl_change,
         p.average_cost
       FROM paper_trades t
       JOIN paper_orders o ON o.id = t.order_id
       LEFT JOIN paper_positions p
         ON p.account_id = t.account_id AND p.instrument_key = t.instrument_key
       WHERE t.account_id = ? AND DATE(t.created_at) = ?
     ) AS sub`,
    [accountId, tradeDate],
  );
  const [peakRow] = await pool.execute<RowDataPacket[]>(
    `SELECT MAX(peak_equity) AS peak_equity
     FROM paper_equity_snapshots
     WHERE account_id = ? AND peak_equity IS NOT NULL`,
    [accountId],
  );
  const cashBalance = number(accountRow.cash_balance);
  const frozenCash = number(accountRow.frozen_cash);
  const marketValue = number(accountMetrics[0]?.market_value);
  const totalEquity = roundMoney(cashBalance + marketValue);
  const orderAmount = roundMoney(quantity * estimatePrice);
  return {
    accountId,
    side,
    securityCode,
    instrumentKey,
    quantity,
    estimatePrice,
    orderAmount,
    currentCash: cashBalance,
    currentFrozenCash: frozenCash,
    currentMarketValue: marketValue,
    currentTotalEquity: totalEquity,
    currentInitialCash: number(accountRow.initial_cash),
    currentSecurityPositionValue: number(accountMetrics[0]?.security_market_value),
    todayTradeCount: Number(todayMetrics[0]?.order_count ?? 0),
    todayTurnover: number(todayMetrics[0]?.turnover),
    todayRealizedPnl: number(todayRealized[0]?.realized),
    peakEquity: peakRow[0]?.peak_equity == null
      ? null
      : number(peakRow[0]?.peak_equity),
    accountStatus: accountRow.status,
  };
}

async function lockAccount(
  connection: PoolConnection,
  accountId: string,
): Promise<AccountRow> {
  const [rows] = await connection.execute<AccountRow[]>(
    'SELECT * FROM paper_accounts WHERE id = ? FOR UPDATE',
    [accountId],
  );
  if (!rows[0]) throw new PaperTradingError('ACCOUNT_NOT_FOUND', '模拟账户不存在', 404);
  return rows[0];
}

async function lockOrder(
  connection: PoolConnection,
  orderId: string,
): Promise<OrderRow | null> {
  const [rows] = await connection.execute<OrderRow[]>(
    'SELECT * FROM paper_orders WHERE id = ? FOR UPDATE',
    [orderId],
  );
  return rows[0] ?? null;
}

async function lockPosition(
  connection: PoolConnection,
  accountId: string,
  instrumentKey: number,
): Promise<PositionRow | null> {
  const [rows] = await connection.execute<PositionRow[]>(
    `SELECT * FROM paper_positions
     WHERE account_id = ? AND instrument_key = ? FOR UPDATE`,
    [accountId, instrumentKey],
  );
  return rows[0] ?? null;
}

async function findOrderByClientId(
  executor: mysql.Pool | PoolConnection,
  accountId: string,
  clientOrderId: string,
): Promise<OrderRow | null> {
  const [rows] = await executor.execute<OrderRow[]>(
    `SELECT * FROM paper_orders
     WHERE account_id = ? AND client_order_id = ? LIMIT 1`,
    [accountId, clientOrderId],
  );
  return rows[0] ?? null;
}

async function getPaperOrderRow(pool: mysql.Pool, orderId: string) {
  const [rows] = await pool.execute<OrderRow[]>(
    'SELECT * FROM paper_orders WHERE id = ? LIMIT 1',
    [orderId],
  );
  return rows[0] ?? null;
}

async function getPaperOrder(pool: mysql.Pool, orderId: string) {
  const order = await getPaperOrderRow(pool, orderId);
  if (!order) throw new PaperTradingError('ORDER_NOT_FOUND', '模拟委托不存在', 404);
  return mapOrder(order);
}

async function releaseOrderFreeze(
  connection: PoolConnection,
  order: OrderRow,
  now: string,
) {
  if (order.side === 'buy' && number(order.frozen_cash) > 0) {
    await connection.execute(
      `UPDATE paper_accounts
       SET frozen_cash = GREATEST(0, frozen_cash - ?), updated_at = ?
       WHERE id = ?`,
      [number(order.frozen_cash), now, order.account_id],
    );
  }
  if (order.side === 'sell' && number(order.frozen_quantity) > 0) {
    await connection.execute(
      `UPDATE paper_positions
       SET frozen_quantity = GREATEST(0, frozen_quantity - ?),
           available_quantity = available_quantity + ?,
           updated_at = ?
       WHERE account_id = ? AND instrument_key = ?`,
      [
        number(order.frozen_quantity),
        number(order.frozen_quantity),
        now,
        order.account_id,
        order.instrument_key,
      ],
    );
  }
}

async function upsertBoughtPosition(
  connection: PoolConnection,
  order: OrderRow,
  quantity: number,
  fillPrice: number,
  commission: number,
  tradeDate: string,
  now: string,
) {
  const unitCost = roundPrice((quantity * fillPrice + commission) / quantity);
  await connection.execute(
    `INSERT INTO paper_positions (
      account_id, instrument_key, security_code, security_name, market,
      total_quantity, available_quantity, frozen_quantity, average_cost,
      last_price, market_value, realized_pnl, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, ?)
    ON DUPLICATE KEY UPDATE
      average_cost = (
        total_quantity * average_cost + VALUES(total_quantity) * VALUES(average_cost)
      ) / (total_quantity + VALUES(total_quantity)),
      last_price = VALUES(last_price),
      market_value = (total_quantity + VALUES(total_quantity)) * VALUES(last_price),
      total_quantity = total_quantity + VALUES(total_quantity),
      updated_at = VALUES(updated_at)`,
    [
      order.account_id,
      order.instrument_key,
      order.security_code,
      order.security_name,
      order.market,
      quantity,
      unitCost,
      fillPrice,
      roundMoney(quantity * fillPrice),
      now,
    ],
  );
  await connection.execute(
    `INSERT INTO paper_position_lots (
      id, account_id, instrument_key, trade_date, quantity,
      available_quantity, unit_cost, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      order.account_id,
      order.instrument_key,
      tradeDate,
      quantity,
      unitCost,
      now,
      now,
    ],
  );
}

async function consumeAvailableLots(
  connection: PoolConnection,
  accountId: string,
  instrumentKey: number,
  requestedQuantity: number,
  now: string,
) {
  const [lots] = await connection.execute<RowDataPacket[]>(
    `SELECT id, quantity, available_quantity
     FROM paper_position_lots
     WHERE account_id = ? AND instrument_key = ? AND available_quantity > 0
     ORDER BY trade_date, created_at, id
     FOR UPDATE`,
    [accountId, instrumentKey],
  );
  let remaining = requestedQuantity;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const consumed = Math.min(number(lot.available_quantity), remaining);
    await connection.execute(
      `UPDATE paper_position_lots
       SET quantity = quantity - ?,
           available_quantity = available_quantity - ?,
           updated_at = ?
       WHERE id = ?`,
      [consumed, consumed, now, lot.id],
    );
    remaining -= consumed;
  }
  if (remaining > 0.000001) {
    throw new PaperTradingError(
      'POSITION_LOT_INCONSISTENT',
      'T+1 持仓批次与可卖数量不一致',
      409,
    );
  }
}

async function insertCashLedger(
  connection: PoolConnection,
  accountId: string,
  orderId: string,
  tradeId: string | null,
  eventType: string,
  amount: number,
  balanceAfter: number,
  frozenAfter: number,
  description: string,
  now: string,
) {
  await connection.execute(
    `INSERT INTO paper_cash_ledger (
      id, account_id, order_id, trade_id, event_type, amount,
      balance_after, frozen_after, description, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      accountId,
      orderId,
      tradeId,
      eventType,
      amount,
      balanceAfter,
      frozenAfter,
      description,
      now,
    ],
  );
}

async function insertAudit(
  connection: PoolConnection,
  accountId: string,
  orderId: string | null,
  eventType: string,
  payload: unknown,
) {
  await connection.execute(
    `INSERT INTO paper_audit_logs (
      account_id, order_id, event_type, event_payload, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
    [accountId, orderId, eventType, JSON.stringify(payload), mysqlDateTime()],
  );
}

function validateOrderDraft(input: SubmitPaperOrderInput) {
  if (!input.accountId || !input.clientOrderId.trim()) {
    throw new PaperTradingError('INVALID_ORDER_IDENTITY', '账户和客户端委托号不能为空');
  }
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new PaperTradingError('INVALID_QUANTITY', '委托数量必须大于 0');
  }
  if (
    input.orderType === 'limit'
    && (!Number.isFinite(input.limitPrice) || Number(input.limitPrice) <= 0)
  ) {
    throw new PaperTradingError('INVALID_LIMIT_PRICE', '限价委托必须提供有效价格');
  }
}

function mapAccount(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    initialCash: number(row.initial_cash),
    cashBalance: number(row.cash_balance),
    frozenCash: number(row.frozen_cash),
    commissionRate: number(row.commission_rate),
    minimumCommission: number(row.minimum_commission),
    sellTaxRate: number(row.sell_tax_rate),
    slippageBps: number(row.slippage_bps),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAccountSummary(row: RowDataPacket) {
  const account = mapAccount(row as AccountRow);
  return {
    ...account,
    availableCash: roundMoney(account.cashBalance - account.frozenCash),
    marketValue: number(row.market_value),
    totalEquity: number(row.total_equity),
  };
}

function mapOrder(row: OrderRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    instrumentKey: row.instrument_key,
    clientOrderId: row.client_order_id,
    securityCode: row.security_code,
    securityName: row.security_name,
    market: row.market,
    side: row.side,
    orderType: row.order_type,
    timeInForce: row.time_in_force,
    quantity: number(row.quantity),
    limitPrice: nullableNumber(row.limit_price),
    status: row.status,
    filledQuantity: number(row.filled_quantity),
    averageFillPrice: nullableNumber(row.average_fill_price),
    frozenCash: number(row.frozen_cash),
    frozenQuantity: number(row.frozen_quantity),
    rejectCode: row.reject_code,
    rejectReason: row.reject_reason,
    ruleVersion: row.rule_version,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

function mapPosition(row: PositionRow) {
  const totalQuantity = number(row.total_quantity);
  const averageCost = number(row.average_cost);
  const lastPrice = nullableNumber(row.last_price);
  return {
    accountId: row.account_id,
    instrumentKey: row.instrument_key,
    securityCode: row.security_code,
    securityName: row.security_name,
    market: row.market,
    totalQuantity,
    availableQuantity: number(row.available_quantity),
    frozenQuantity: number(row.frozen_quantity),
    averageCost,
    lastPrice,
    marketValue: number(row.market_value),
    realizedPnl: number(row.realized_pnl),
    unrealizedPnl: lastPrice == null
      ? null
      : roundMoney((lastPrice - averageCost) * totalQuantity),
    updatedAt: row.updated_at,
  };
}

function mapNumericRow(row: RowDataPacket) {
  const mapped: Record<string, unknown> = { ...row };
  for (const key of [
    'quantity',
    'raw_price',
    'fill_price',
    'amount',
    'commission',
    'tax',
    'slippage_cost',
    'balance_after',
    'frozen_after',
  ]) {
    if (key in mapped && mapped[key] != null) mapped[key] = number(mapped[key]);
  }
  return mapped;
}

function mapMarketPhase(phase: ReturnType<typeof getChinaMarketSession>['phase']) {
  if (phase === 'morning' || phase === 'afternoon') return 'continuous_trading' as const;
  if (phase === 'lunch') return 'lunch_break' as const;
  if (phase === 'pre_open') return 'pre_open' as const;
  return 'closed' as const;
}

function isRiskWarningName(name: string) {
  return /^(?:\*?ST|S\*?ST)/i.test(name.trim());
}

function mysqlDateTime(value = new Date()) {
  return value.toISOString().slice(0, 23).replace('T', ' ');
}

function normalizeQuoteTime(value: string) {
  const normalized = value.trim().replace('T', ' ').replace(/Z$/, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return `${normalized} 15:00:00.000`;
  return normalized.slice(0, 23);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDuplicateKey(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ER_DUP_ENTRY',
  );
}
