import type mysql from 'mysql2/promise';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { TRADING_RULES_VERSION } from '../../../shared/trading-rules/index.js';

export const PAPER_STRATEGY_BINDING_VERSION = `paper-binding-${TRADING_RULES_VERSION}`;

export type PaperStrategyBindingStatus =
  | 'paused'
  | 'active'
  | 'stopped'
  | 'error';

export interface PaperStrategyBinding {
  id: string;
  accountId: string;
  strategyId: string;
  strategyName: string;
  params: Record<string, unknown>;
  status: PaperStrategyBindingStatus;
  lastEvaluatedAt: string | null;
  lastSignal: Record<string, unknown> | null;
  lastError: string | null;
  lastIntentKey: string | null;
  lastIntentAt: string | null;
  ruleVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePaperStrategyBindingInput {
  accountId: string;
  strategyId: string;
  strategyName: string;
  params?: Record<string, unknown>;
  status?: PaperStrategyBindingStatus;
}

export interface UpdatePaperStrategyBindingInput {
  status?: PaperStrategyBindingStatus;
  params?: Record<string, unknown>;
  strategyName?: string;
}

const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<PaperStrategyBindingStatus, readonly PaperStrategyBindingStatus[]>
> = {
  paused: ['active', 'stopped'],
  active: ['paused', 'stopped', 'error'],
  stopped: ['paused'],
  error: ['paused', 'stopped'],
};

export function canTransitionBindingStatus(
  from: PaperStrategyBindingStatus,
  to: PaperStrategyBindingStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

export function assertBindingStatusTransition(
  from: PaperStrategyBindingStatus,
  to: PaperStrategyBindingStatus,
): void {
  if (!canTransitionBindingStatus(from, to)) {
    throw new Error(`非法策略绑定状态转换：${from} -> ${to}`);
  }
}

interface BindingRow extends RowDataPacket {
  id: string;
  account_id: string;
  strategy_id: string;
  strategy_name: string;
  params: string;
  status: PaperStrategyBindingStatus;
  last_evaluated_at: string | null;
  last_signal: string | null;
  last_error: string | null;
  last_intent_key: string | null;
  last_intent_at: string | null;
  rule_version: string;
  created_at: string;
  updated_at: string;
}

export async function createPaperStrategyBinding(
  pool: mysql.Pool,
  input: CreatePaperStrategyBindingInput,
): Promise<PaperStrategyBinding> {
  validateBindingInput(input);
  const id = crypto.randomUUID();
  const now = mysqlDateTime();
  const params = input.params ?? {};
  const status = input.status ?? 'paused';
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await lockAccount(connection, input.accountId);
    await connection.execute(
      `INSERT INTO paper_strategy_bindings (
        id, account_id, strategy_id, strategy_name, params, status,
        last_evaluated_at, last_signal, last_error,
        last_intent_key, last_intent_at,
        rule_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      [
        id,
        input.accountId,
        input.strategyId,
        input.strategyName,
        JSON.stringify(params),
        status,
        PAPER_STRATEGY_BINDING_VERSION,
        now,
        now,
      ],
    );
    await insertAudit(
      connection,
      input.accountId,
      id,
      'binding_created',
      { strategyId: input.strategyId, status },
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const binding = await getPaperStrategyBinding(pool, id);
  if (!binding) throw new Error('策略绑定创建后无法读取');
  return binding;
}

export async function listPaperStrategyBindings(
  pool: mysql.Pool,
  accountId?: string,
): Promise<PaperStrategyBinding[]> {
  const rows: BindingRow[] = accountId
    ? await fetchBindingsByAccount(pool, accountId)
    : await fetchAllBindings(pool);
  return rows.map(mapBinding);
}

export async function getPaperStrategyBinding(
  pool: mysql.Pool,
  bindingId: string,
): Promise<PaperStrategyBinding | null> {
  const [rows] = await pool.execute<BindingRow[]>(
    'SELECT * FROM paper_strategy_bindings WHERE id = ? LIMIT 1',
    [bindingId],
  );
  return rows[0] ? mapBinding(rows[0]) : null;
}

export async function updatePaperStrategyBinding(
  pool: mysql.Pool,
  bindingId: string,
  input: UpdatePaperStrategyBindingInput,
): Promise<PaperStrategyBinding> {
  const connection = await pool.getConnection();
  const now = mysqlDateTime();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<BindingRow[]>(
      'SELECT * FROM paper_strategy_bindings WHERE id = ? FOR UPDATE',
      [bindingId],
    );
    const existing = rows[0];
    if (!existing) {
      await connection.rollback();
      throw new Error(`策略绑定不存在：${bindingId}`);
    }
    const nextStatus = input.status ?? existing.status;
    if (nextStatus !== existing.status) {
      assertBindingStatusTransition(existing.status, nextStatus);
    }
    const nextParams = input.params
      ? JSON.stringify(input.params)
      : existing.params;
    const nextName = input.strategyName ?? existing.strategy_name;
    await connection.execute(
      `UPDATE paper_strategy_bindings
       SET status = ?, params = ?, strategy_name = ?, updated_at = ?
       WHERE id = ?`,
      [nextStatus, nextParams, nextName, now, bindingId],
    );
    await insertAudit(
      connection,
      existing.account_id,
      bindingId,
      'binding_updated',
      {
        fromStatus: existing.status,
        toStatus: nextStatus,
        strategyName: nextName,
      },
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const updated = await getPaperStrategyBinding(pool, bindingId);
  if (!updated) throw new Error('策略绑定更新后无法读取');
  return updated;
}

export async function deletePaperStrategyBinding(
  pool: mysql.Pool,
  bindingId: string,
): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<BindingRow[]>(
      'SELECT account_id FROM paper_strategy_bindings WHERE id = ? FOR UPDATE',
      [bindingId],
    );
    const existing = rows[0];
    if (!existing) {
      await connection.rollback();
      return;
    }
    await connection.execute(
      'DELETE FROM paper_strategy_bindings WHERE id = ?',
      [bindingId],
    );
    await insertAudit(
      connection,
      existing.account_id,
      bindingId,
      'binding_deleted',
      {},
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * 由策略执行器在生成交易意图后调用，记录策略评估时间、信号、当日意图幂等键与错误。
 * 同一交易日重复调用同一 intentKey 视为幂等成功，不更新评估时间。
 */
export async function recordStrategyEvaluation(
  pool: mysql.Pool,
  bindingId: string,
  payload: {
    signal: Record<string, unknown> | null;
    intentKey?: string | null;
    error?: string | null;
  },
): Promise<void> {
  const connection = await pool.getConnection();
  const now = mysqlDateTime();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<BindingRow[]>(
      'SELECT * FROM paper_strategy_bindings WHERE id = ? FOR UPDATE',
      [bindingId],
    );
    const existing = rows[0];
    if (!existing) {
      await connection.rollback();
      throw new Error(`策略绑定不存在：${bindingId}`);
    }
    const shouldUpdateIntent = payload.intentKey != null
      && payload.intentKey !== existing.last_intent_key;
    const nextStatus: PaperStrategyBindingStatus = payload.error != null
      && existing.status !== 'stopped'
      ? 'error'
      : existing.status;
    await connection.execute(
      `UPDATE paper_strategy_bindings
       SET last_evaluated_at = ?,
           last_signal = ?,
           last_error = ?,
           last_intent_key = ?,
           last_intent_at = ?,
           status = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        now,
        payload.signal ? JSON.stringify(payload.signal) : null,
        payload.error ?? null,
        shouldUpdateIntent ? (payload.intentKey ?? null) : existing.last_intent_key,
        shouldUpdateIntent ? now : existing.last_intent_at,
        nextStatus,
        now,
        bindingId,
      ],
    );
    await insertAudit(
      connection,
      existing.account_id,
      bindingId,
      'strategy_evaluated',
      {
        intentKey: payload.intentKey ?? null,
        hasError: Boolean(payload.error),
      },
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function fetchBindingsByAccount(
  pool: mysql.Pool,
  accountId: string,
): Promise<BindingRow[]> {
  const [rows] = await pool.execute<BindingRow[]>(
    'SELECT * FROM paper_strategy_bindings WHERE account_id = ? ORDER BY created_at',
    [accountId],
  );
  return rows;
}

async function fetchAllBindings(pool: mysql.Pool): Promise<BindingRow[]> {
  const [rows] = await pool.query<BindingRow[]>(
    'SELECT * FROM paper_strategy_bindings ORDER BY created_at DESC LIMIT 500',
  );
  return rows;
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

async function insertAudit(
  connection: PoolConnection,
  accountId: string,
  bindingId: string | null,
  eventType: string,
  payload: unknown,
): Promise<void> {
  await connection.execute(
    `INSERT INTO paper_audit_logs (
      account_id, order_id, event_type, event_payload, created_at
    ) VALUES (?, NULL, ?, ?, ?)`,
    [
      accountId,
      `binding:${eventType}:${bindingId ?? 'unknown'}`,
      JSON.stringify(payload),
      mysqlDateTime(),
    ],
  );
}

function validateBindingInput(input: CreatePaperStrategyBindingInput) {
  if (!input.accountId.trim()) {
    throw new Error('账户ID不能为空');
  }
  if (!input.strategyId.trim()) {
    throw new Error('策略ID不能为空');
  }
  if (!input.strategyName.trim()) {
    throw new Error('策略名称不能为空');
  }
  if (input.params && typeof input.params !== 'object') {
    throw new Error('策略参数必须是对象');
  }
}

function mapBinding(row: BindingRow): PaperStrategyBinding {
  return {
    id: row.id,
    accountId: row.account_id,
    strategyId: row.strategy_id,
    strategyName: row.strategy_name,
    params: safeParse(row.params),
    status: row.status,
    lastEvaluatedAt: row.last_evaluated_at,
    lastSignal: row.last_signal ? safeParse(row.last_signal) : null,
    lastError: row.last_error,
    lastIntentKey: row.last_intent_key,
    lastIntentAt: row.last_intent_at,
    ruleVersion: row.rule_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function mysqlDateTime(value = new Date()) {
  return value.toISOString().slice(0, 23).replace('T', ' ');
}
