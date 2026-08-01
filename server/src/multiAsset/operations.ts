import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

const { multiAssetRuns, multiAssetRunArtifacts, multiAssetWorkers } = schema;

export type MultiAssetWorkerMode = 'embedded' | 'standalone';
export type MultiAssetWorkerStatus = 'starting' | 'ready' | 'draining' | 'stopped';

export async function registerMultiAssetWorker(input: {
  mode: MultiAssetWorkerMode;
  hostname: string;
  pid: number;
  concurrency: number;
  metadata?: unknown;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  if (input.mode === 'embedded') {
    await getDb().update(multiAssetWorkers).set({
      status: 'stopped',
      lastHeartbeatAt: now,
      stoppedAt: now,
    }).where(and(
      eq(multiAssetWorkers.mode, input.mode),
      eq(multiAssetWorkers.hostname, input.hostname),
      ne(multiAssetWorkers.status, 'stopped'),
    ));
  }
  await getDb().insert(multiAssetWorkers).values({
    id,
    mode: input.mode,
    hostname: input.hostname,
    pid: input.pid,
    concurrency: input.concurrency,
    status: 'ready',
    startedAt: now,
    lastHeartbeatAt: now,
    stoppedAt: null,
    metadata: input.metadata ?? null,
  });
  return id;
}

export async function heartbeatMultiAssetWorker(
  id: string,
  status: MultiAssetWorkerStatus = 'ready',
  metadata?: unknown,
): Promise<void> {
  await getDb().update(multiAssetWorkers).set({
    status,
    lastHeartbeatAt: new Date().toISOString(),
    ...(metadata === undefined ? {} : { metadata }),
  }).where(eq(multiAssetWorkers.id, id));
}

export async function stopMultiAssetWorker(id: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().update(multiAssetWorkers).set({
    status: 'stopped',
    lastHeartbeatAt: now,
    stoppedAt: now,
  }).where(eq(multiAssetWorkers.id, id));
}

export interface MultiAssetOperationalStatus {
  level: 'healthy' | 'warning' | 'critical';
  checkedAt: string;
  alerts: Array<{ code: string; level: 'warning' | 'critical'; message: string }>;
  queue: {
    counts: Record<string, number>;
    oldestWaitingSeconds: number | null;
    expiredRunningLeases: number;
  };
  workers: {
    fresh: number;
    stale: number;
    stopped: number;
    capacity: number;
    entries: Array<{
      id: string;
      mode: string;
      hostname: string;
      pid: number;
      concurrency: number;
      status: string;
      lastHeartbeatAt: string;
      stale: boolean;
    }>;
  };
  artifacts: { count: number; bytes: number };
}

export function evaluateMultiAssetOperationalAlerts(input: {
  waiting: number;
  freshWorkers: number;
  staleWorkers: number;
  expiredRunningLeases: number;
  oldestWaitingSeconds: number | null;
  queueWarningSeconds: number;
  queueCriticalSeconds: number;
}): Pick<MultiAssetOperationalStatus, 'level' | 'alerts'> {
  const alerts: MultiAssetOperationalStatus['alerts'] = [];
  if (input.expiredRunningLeases > 0) {
    alerts.push({ code: 'EXPIRED_RUNNING_LEASES', level: 'critical', message: '存在租约已过期但尚未恢复的运行任务' });
  }
  if (input.staleWorkers > 0) {
    alerts.push({ code: 'STALE_WORKERS', level: 'critical', message: `检测到 ${input.staleWorkers} 个失联 Worker` });
  }
  if (input.waiting > 0 && input.freshWorkers === 0) {
    alerts.push({ code: 'NO_ACTIVE_WORKER', level: 'critical', message: '队列存在待处理任务，但没有存活 Worker' });
  }
  if (input.oldestWaitingSeconds !== null && input.oldestWaitingSeconds >= input.queueCriticalSeconds) {
    alerts.push({ code: 'QUEUE_WAIT_CRITICAL', level: 'critical', message: `最老任务已等待 ${input.oldestWaitingSeconds} 秒` });
  } else if (input.oldestWaitingSeconds !== null && input.oldestWaitingSeconds >= input.queueWarningSeconds) {
    alerts.push({ code: 'QUEUE_WAIT_WARNING', level: 'warning', message: `最老任务已等待 ${input.oldestWaitingSeconds} 秒` });
  }
  return {
    level: alerts.some((alert) => alert.level === 'critical')
      ? 'critical'
      : alerts.length > 0 ? 'warning' : 'healthy',
    alerts,
  };
}

export async function collectMultiAssetOperationalStatus(input: {
  workerStaleMs: number;
  queueWarningSeconds: number;
  queueCriticalSeconds: number;
}): Promise<MultiAssetOperationalStatus> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - input.workerStaleMs).toISOString();
  const statusRows = await getDb().select({
    status: multiAssetRuns.status,
    count: sql<number>`count(*)`,
  }).from(multiAssetRuns).groupBy(multiAssetRuns.status);
  const counts = Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)]));
  const [oldest] = await getDb().select({ createdAt: multiAssetRuns.createdAt })
    .from(multiAssetRuns)
    .where(inArray(multiAssetRuns.status, ['queued', 'retry_wait']))
    .orderBy(asc(multiAssetRuns.createdAt)).limit(1);
  const [expiredRow] = await getDb().select({ count: sql<number>`count(*)` })
    .from(multiAssetRuns)
    .where(and(eq(multiAssetRuns.status, 'running'), lte(multiAssetRuns.leaseExpiresAt, now)));
  const workerRows = await getDb().select().from(multiAssetWorkers)
    .where(ne(multiAssetWorkers.status, 'stopped'))
    .orderBy(asc(multiAssetWorkers.startedAt)).limit(500);
  const [stoppedRow] = await getDb().select({ count: sql<number>`count(*)` })
    .from(multiAssetWorkers).where(eq(multiAssetWorkers.status, 'stopped'));
  const [artifactRow] = await getDb().select({
    count: sql<number>`count(*)`,
    bytes: sql<number>`coalesce(sum(${multiAssetRunArtifacts.byteSize}), 0)`,
  }).from(multiAssetRunArtifacts);

  const oldestWaitingSeconds = oldest
    ? Math.max(0, Math.floor((nowMs - Date.parse(oldest.createdAt)) / 1000))
    : null;
  const entries = workerRows.map((worker) => ({
    id: worker.id,
    mode: worker.mode,
    hostname: worker.hostname,
    pid: worker.pid,
    concurrency: worker.concurrency,
    status: worker.status,
    lastHeartbeatAt: worker.lastHeartbeatAt,
    stale: worker.lastHeartbeatAt <= staleBefore,
  }));
  const fresh = entries.filter((worker) => !worker.stale).length;
  const stale = entries.length - fresh;
  const waiting = (counts.queued ?? 0) + (counts.retry_wait ?? 0);
  const { level, alerts } = evaluateMultiAssetOperationalAlerts({
    waiting,
    freshWorkers: fresh,
    staleWorkers: stale,
    expiredRunningLeases: Number(expiredRow?.count ?? 0),
    oldestWaitingSeconds,
    queueWarningSeconds: input.queueWarningSeconds,
    queueCriticalSeconds: input.queueCriticalSeconds,
  });
  return {
    level,
    checkedAt: now,
    alerts,
    queue: { counts, oldestWaitingSeconds, expiredRunningLeases: Number(expiredRow?.count ?? 0) },
    workers: {
      fresh,
      stale,
      stopped: Number(stoppedRow?.count ?? 0),
      capacity: entries.filter((worker) => !worker.stale && worker.status === 'ready')
        .reduce((sum, worker) => sum + worker.concurrency, 0),
      entries,
    },
    artifacts: { count: Number(artifactRow?.count ?? 0), bytes: Number(artifactRow?.bytes ?? 0) },
  };
}
