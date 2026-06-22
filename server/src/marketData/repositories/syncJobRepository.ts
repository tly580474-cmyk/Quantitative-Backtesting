import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { SyncJob, SyncJobItem } from '../../marketData/types.js';

const { syncJobs, syncJobItems } = schema;
const CHUNK_SIZE = 500;

// ─── Sync Jobs ──────────────────────────────────────────────────────

export async function createSyncJob(job: SyncJob): Promise<void> {
  await getDb().insert(syncJobs).values(job);
}

export async function getSyncJob(id: string): Promise<SyncJob | null> {
  const rows = await getDb()
    .select()
    .from(syncJobs)
    .where(eq(syncJobs.id, id))
    .limit(1);
  return (rows[0] as SyncJob) ?? null;
}

export async function listSyncJobs(
  filters?: {
    status?: string;
    jobType?: string;
    offset?: number;
    limit?: number;
  },
): Promise<{ data: SyncJob[]; total: number }> {
  const _offset = filters?.offset ?? 0;
  const _limit = filters?.limit ?? 50;

  const conditions: ReturnType<typeof eq>[] = [];

  if (filters?.status) conditions.push(eq(syncJobs.status, filters.status));
  if (filters?.jobType) conditions.push(eq(syncJobs.jobType, filters.jobType));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const baseQuery = getDb()
    .select()
    .from(syncJobs)
    .$dynamic();

  const countQuery = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(syncJobs)
    .$dynamic();

  if (where) {
    baseQuery.where(where);
    countQuery.where(where);
  }

  const [data, [countRow]] = await Promise.all([
    baseQuery.orderBy(desc(syncJobs.createdAt)).limit(_limit).offset(_offset),
    countQuery,
  ]);

  return {
    data: data as SyncJob[],
    total: Number(countRow?.count ?? 0),
  };
}

export async function updateSyncJobStatus(
  id: string,
  status: string,
  startedAt?: string,
  finishedAt?: string,
): Promise<void> {
  const setObj: Record<string, unknown> = { status };

  if (startedAt !== undefined) setObj.startedAt = startedAt;
  if (finishedAt !== undefined) setObj.finishedAt = finishedAt;

  await getDb()
    .update(syncJobs)
    .set(setObj)
    .where(eq(syncJobs.id, id));
}

export async function updateSyncJobCounts(
  id: string,
  totalItems: number,
  completedItems: number,
  failedItems: number,
): Promise<void> {
  await getDb()
    .update(syncJobs)
    .set({ totalItems, completedItems, failedItems })
    .where(eq(syncJobs.id, id));
}

// ─── Sync Job Items ─────────────────────────────────────────────────

export async function createSyncJobItems(
  items: SyncJobItem[],
): Promise<void> {
  await getDb().transaction(async (tx) => {
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      await tx
        .insert(syncJobItems)
        .values(items.slice(i, i + CHUNK_SIZE));
    }
  });
}

export async function updateSyncJobItem(
  id: string,
  updates: {
    status?: string;
    attempts?: number;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<void> {
  const setObj: Record<string, unknown> = {};

  if (updates.status !== undefined) setObj.status = updates.status;

  // Drizzle .set() passes undefined values to MySQL which causes errors,
  // so we use sql to explicitly set null for optional fields.
  if (updates.errorCode !== undefined) {
    setObj.errorCode = updates.errorCode;
  }
  if (updates.errorMessage !== undefined) {
    setObj.errorMessage = updates.errorMessage;
  }
  if (updates.attempts !== undefined) setObj.attempts = updates.attempts;

  if (Object.keys(setObj).length === 0) return;

  await getDb()
    .update(syncJobItems)
    .set(setObj)
    .where(eq(syncJobItems.id, id));
}

export async function getSyncJobItems(
  jobId: string,
): Promise<SyncJobItem[]> {
  const rows = await getDb()
    .select()
    .from(syncJobItems)
    .where(eq(syncJobItems.jobId, jobId))
    .orderBy(syncJobItems.instrumentId);

  return rows as SyncJobItem[];
}

export async function getPendingItems(
  jobId: string,
  limit?: number,
): Promise<SyncJobItem[]> {
  const _limit = limit ?? 100;

  const rows = await getDb()
    .select()
    .from(syncJobItems)
    .where(
      and(
        eq(syncJobItems.jobId, jobId),
        eq(syncJobItems.status, 'pending'),
      ),
    )
    .orderBy(syncJobItems.instrumentId)
    .limit(_limit);

  return rows as SyncJobItem[];
}

export async function getRunningJob(type?: string): Promise<SyncJob | null> {
  const conditions: ReturnType<typeof eq>[] = [
    sql`${syncJobs.status} IN ('pending', 'running')`,
  ];

  if (type) conditions.push(eq(syncJobs.jobType, type));

  const rows = await getDb()
    .select()
    .from(syncJobs)
    .where(and(...conditions))
    .orderBy(desc(syncJobs.createdAt))
    .limit(1);

  return (rows[0] as SyncJob) ?? null;
}
