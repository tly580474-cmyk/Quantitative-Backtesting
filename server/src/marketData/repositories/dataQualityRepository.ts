import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { DataQualityIssue } from '../../marketData/types.js';

const { dataQualityIssues } = schema;

interface ListFilters {
  status?: string;
  severity?: string;
  instrumentId?: string;
  offset?: number;
  limit?: number;
}

export async function createQualityIssue(
  issue: DataQualityIssue,
): Promise<void> {
  await getDb().insert(dataQualityIssues).values(issue);
}

export async function listQualityIssues(
  filters?: ListFilters,
): Promise<{ data: DataQualityIssue[]; total: number }> {
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters?.status) {
    conditions.push(eq(dataQualityIssues.status, filters.status));
  }
  if (filters?.severity) {
    conditions.push(eq(dataQualityIssues.severity, filters.severity));
  }
  if (filters?.instrumentId) {
    conditions.push(
      eq(dataQualityIssues.instrumentId, filters.instrumentId),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const _offset = filters?.offset ?? 0;
  const _limit = filters?.limit ?? 100;

  const baseQuery = getDb()
    .select()
    .from(dataQualityIssues)
    .$dynamic();

  const countQuery = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(dataQualityIssues)
    .$dynamic();

  if (where) {
    baseQuery.where(where);
    countQuery.where(where);
  }

  const [data, [countRow]] = await Promise.all([
    baseQuery
      .orderBy(desc(dataQualityIssues.detectedAt))
      .limit(_limit)
      .offset(_offset),
    countQuery,
  ]);

  return {
    data: data as DataQualityIssue[],
    total: Number(countRow?.count ?? 0),
  };
}

export async function getOpenQualitySeverities(instrumentIds: string[]) {
  if (instrumentIds.length === 0) return [];
  return getDb()
    .select({
      instrumentId: dataQualityIssues.instrumentId,
      severity: dataQualityIssues.severity,
    })
    .from(dataQualityIssues)
    .where(and(
      inArray(dataQualityIssues.instrumentId, instrumentIds),
      eq(dataQualityIssues.status, 'open'),
    ));
}

export async function updateQualityIssue(
  id: string,
  updates: {
    status?: string;
    resolvedAt?: string;
  },
): Promise<void> {
  const setObj: Record<string, unknown> = {};

  if (updates.status !== undefined) setObj.status = updates.status;
  if (updates.resolvedAt !== undefined) setObj.resolvedAt = updates.resolvedAt;

  if (Object.keys(setObj).length === 0) return;

  await getDb()
    .update(dataQualityIssues)
    .set(setObj)
    .where(eq(dataQualityIssues.id, id));
}

export async function deleteQualityIssuesByInstrument(
  instrumentId: string,
): Promise<void> {
  await getDb()
    .delete(dataQualityIssues)
    .where(eq(dataQualityIssues.instrumentId, instrumentId));
}
