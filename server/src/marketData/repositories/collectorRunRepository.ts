import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';

const { marketDataCollectorRuns } = schema;

export interface CollectorRun {
  runKey: string;
  jobType: string;
  status: 'running' | 'succeeded' | 'failed';
  attempts: number;
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
  details?: Record<string, unknown>;
}

export async function tryStartCollectorRun(runKey: string, jobType: string): Promise<boolean> {
  const result = await getDb().execute(sql`
    INSERT IGNORE INTO ${marketDataCollectorRuns}
      (${marketDataCollectorRuns.runKey}, ${marketDataCollectorRuns.jobType}, ${marketDataCollectorRuns.status}, ${marketDataCollectorRuns.attempts}, ${marketDataCollectorRuns.startedAt})
    VALUES (${runKey}, ${jobType}, 'running', 1, ${mysqlUtcNow()})
  `);
  const packet = result[0] as { affectedRows?: number };
  if (Number(packet.affectedRows ?? 0) > 0) return true;
  const retry = await getDb().update(marketDataCollectorRuns).set({
    status: 'running',
    attempts: sql`${marketDataCollectorRuns.attempts} + 1`,
    startedAt: mysqlUtcNow(),
    finishedAt: null,
    errorMessage: null,
  }).where(and(
    eq(marketDataCollectorRuns.runKey, runKey),
    eq(marketDataCollectorRuns.status, 'failed'),
    lt(marketDataCollectorRuns.attempts, 3),
  ));
  const retryPacket = retry[0] as { affectedRows?: number };
  return Number(retryPacket.affectedRows ?? 0) > 0;
}

export async function finishCollectorRun(
  runKey: string,
  status: 'succeeded' | 'failed',
  options: { errorMessage?: string; details?: Record<string, unknown> } = {},
): Promise<void> {
  await getDb().update(marketDataCollectorRuns).set({
    status,
    finishedAt: mysqlUtcNow(),
    errorMessage: options.errorMessage?.slice(0, 1000) ?? null,
    details: options.details ?? null,
  }).where(eq(marketDataCollectorRuns.runKey, runKey));
}

export async function latestCollectorRuns(): Promise<CollectorRun[]> {
  const latest = getDb().select({
    jobType: marketDataCollectorRuns.jobType,
    startedAt: sql<string>`MAX(${marketDataCollectorRuns.startedAt})`.as('started_at'),
  }).from(marketDataCollectorRuns).groupBy(marketDataCollectorRuns.jobType).as('latest');
  const rows = await getDb().select().from(marketDataCollectorRuns)
    .innerJoin(latest, sql`${marketDataCollectorRuns.jobType} = ${latest.jobType} AND ${marketDataCollectorRuns.startedAt} = ${latest.startedAt}`)
    .orderBy(desc(marketDataCollectorRuns.startedAt));
  return rows.map(({ market_data_collector_runs: row }) => ({
    runKey: row.runKey,
    jobType: row.jobType,
    status: row.status as CollectorRun['status'],
    attempts: row.attempts,
    startedAt: fromMysqlUtc(row.startedAt),
    finishedAt: row.finishedAt ? fromMysqlUtc(row.finishedAt) : undefined,
    errorMessage: row.errorMessage ?? undefined,
    details: row.details as Record<string, unknown> | undefined,
  }));
}

function mysqlUtcNow(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function fromMysqlUtc(value: string): string {
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}
