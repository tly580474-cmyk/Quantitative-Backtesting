import { randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { StrategyStatus } from './strategyGovernance.js';

export interface StrategyVersion {
  id: string;
  name: string;
  parentVersionId: string | null;
  status: StrategyStatus;
  factorVersions: Array<{ versionId: string; family: string; weight: number }>;
  compositeWeights: Record<string, number>;
  universeConfig: Record<string, unknown>;
  preprocessingConfig: Record<string, unknown>;
  optimizerConfig: Record<string, unknown>;
  costConfig: Record<string, unknown>;
  snapshotId: string;
  codeChecksum: string;
  randomSeeds: number[];
  paperAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function createStrategyVersion(pool: Pool, input: Omit<StrategyVersion,
  'id' | 'status' | 'paperAccountId' | 'createdAt' | 'updatedAt'>): Promise<StrategyVersion> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool.execute(
    `INSERT INTO factor_strategy_versions (
      id, name, parent_version_id, status, factor_versions, composite_weights,
      universe_config, preprocessing_config, optimizer_config, cost_config,
      snapshot_id, code_checksum, random_seeds, created_at, updated_at
    ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.parentVersionId, json(input.factorVersions), json(input.compositeWeights),
      json(input.universeConfig), json(input.preprocessingConfig), json(input.optimizerConfig),
      json(input.costConfig), input.snapshotId, input.codeChecksum, json(input.randomSeeds), now, now],
  );
  return (await getStrategyVersion(pool, id))!;
}

export async function listStrategyVersions(pool: Pool): Promise<StrategyVersion[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM factor_strategy_versions ORDER BY created_at DESC LIMIT 200',
  );
  return rows.map(mapStrategy);
}

export async function getStrategyVersion(pool: Pool, id: string): Promise<StrategyVersion | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM factor_strategy_versions WHERE id = ? LIMIT 1', [id],
  );
  return rows[0] ? mapStrategy(rows[0]) : null;
}

export async function updateStrategyStatus(
  pool: Pool,
  id: string,
  status: StrategyStatus,
  paperAccountId?: string,
): Promise<StrategyVersion> {
  await pool.execute(
    `UPDATE factor_strategy_versions
     SET status = ?, paper_account_id = COALESCE(?, paper_account_id), updated_at = ?
     WHERE id = ?`,
    [status, paperAccountId ?? null, new Date().toISOString(), id],
  );
  const result = await getStrategyVersion(pool, id);
  if (!result) throw new Error('strategy version not found');
  return result;
}

export async function addStrategyEvaluation(pool: Pool, input: {
  strategyVersionId: string; evaluationType: string; metrics: unknown;
  gateResult: unknown; artifactUri?: string;
}): Promise<void> {
  await pool.execute(
    `INSERT INTO factor_strategy_evaluations
     (id, strategy_version_id, evaluation_type, metrics, gate_result, artifact_uri, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), input.strategyVersionId, input.evaluationType, json(input.metrics),
      json(input.gateResult), input.artifactUri ?? null, new Date().toISOString()],
  );
}

export async function addPaperObservation(pool: Pool, input: {
  strategyVersionId: string; rebalanceCycle: number; observationDate: string;
  metrics: unknown; violations: string[];
}): Promise<void> {
  await pool.execute(
    `INSERT INTO factor_strategy_paper_observations
     (id, strategy_version_id, rebalance_cycle, observation_date, metrics, violations, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE metrics=VALUES(metrics), violations=VALUES(violations)`,
    [randomUUID(), input.strategyVersionId, input.rebalanceCycle, input.observationDate,
      json(input.metrics), json(input.violations), new Date().toISOString()],
  );
}

export async function getStrategyPerformance(pool: Pool, strategyVersionId: string) {
  const [evaluations] = await pool.execute<RowDataPacket[]>(
    `SELECT id, evaluation_type AS evaluationType, metrics, gate_result AS gateResult,
            artifact_uri AS artifactUri, created_at AS createdAt
     FROM factor_strategy_evaluations WHERE strategy_version_id = ? ORDER BY created_at`,
    [strategyVersionId],
  );
  const [observations] = await pool.execute<RowDataPacket[]>(
    `SELECT id, rebalance_cycle AS rebalanceCycle, observation_date AS observationDate,
            metrics, violations, created_at AS createdAt
     FROM factor_strategy_paper_observations WHERE strategy_version_id = ?
     ORDER BY rebalance_cycle`,
    [strategyVersionId],
  );
  return {
    evaluations: evaluations.map(parseJsonColumns),
    observations: observations.map(parseJsonColumns),
  };
}

export async function hasStrategyEvaluationSince(
  pool: Pool,
  strategyVersionId: string,
  evaluationType: string,
  since: string,
): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM factor_strategy_evaluations
     WHERE strategy_version_id = ? AND evaluation_type = ? AND created_at >= ? LIMIT 1`,
    [strategyVersionId, evaluationType, since],
  );
  return rows.length > 0;
}

export async function promoteStrategy(pool: Pool, input: {
  strategyVersionId: string; approvedBy: string; reason?: string; gateResult: unknown;
}): Promise<StrategyVersion> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [champions] = await connection.query<RowDataPacket[]>(
      "SELECT id FROM factor_strategy_versions WHERE status = 'champion' FOR UPDATE",
    );
    const priorChampionId = champions[0]?.id ? String(champions[0].id) : null;
    if (priorChampionId) {
      await connection.execute(
        "UPDATE factor_strategy_versions SET status='validated', updated_at=? WHERE id=?",
        [new Date().toISOString(), priorChampionId],
      );
    }
    await connection.execute(
      "UPDATE factor_strategy_versions SET status='champion', updated_at=? WHERE id=? AND status='paper'",
      [new Date().toISOString(), input.strategyVersionId],
    );
    await connection.execute(
      `INSERT INTO factor_strategy_promotion_audits
       (id, strategy_version_id, prior_champion_id, decision, approved_by, reason, gate_result, created_at)
       VALUES (?, ?, ?, 'approved', ?, ?, ?, ?)`,
      [randomUUID(), input.strategyVersionId, priorChampionId, input.approvedBy,
        input.reason ?? null, json(input.gateResult), new Date().toISOString()],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return (await getStrategyVersion(pool, input.strategyVersionId))!;
}

function mapStrategy(row: RowDataPacket): StrategyVersion {
  return {
    id: String(row.id), name: String(row.name),
    parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null,
    status: String(row.status) as StrategyStatus,
    factorVersions: parse(row.factor_versions) as StrategyVersion['factorVersions'],
    compositeWeights: parse(row.composite_weights) as Record<string, number>,
    universeConfig: parse(row.universe_config) as Record<string, unknown>,
    preprocessingConfig: parse(row.preprocessing_config) as Record<string, unknown>,
    optimizerConfig: parse(row.optimizer_config) as Record<string, unknown>,
    costConfig: parse(row.cost_config) as Record<string, unknown>,
    snapshotId: String(row.snapshot_id), codeChecksum: String(row.code_checksum),
    randomSeeds: parse(row.random_seeds) as number[],
    paperAccountId: row.paper_account_id ? String(row.paper_account_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function parseJsonColumns(row: RowDataPacket): Record<string, unknown> {
  const result = { ...row } as Record<string, unknown>;
  for (const key of ['metrics', 'gateResult', 'violations']) {
    if (key in result) result[key] = parse(result[key]);
  }
  return result;
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
