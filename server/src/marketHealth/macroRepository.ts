import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

const { macroObservations } = schema;

export interface MacroObservationInput {
  seriesKey: string;
  observationPeriod: string;
  value: number;
  publishedAt: string | null;
  availableAt: string;
  fetchedAt: string;
  sourceKey: string;
  authorityKey: string;
  sourceUrl: string | null;
  sourceChecksum: string;
  status: 'observed' | 'revised';
}

export interface StoredMacroObservation extends MacroObservationInput {
  id: number;
  revisionNo: number;
}

export async function listMacroObservationVersions(seriesKey: string): Promise<StoredMacroObservation[]> {
  const rows = await getDb().select().from(macroObservations)
    .where(eq(macroObservations.seriesKey, seriesKey))
    .orderBy(asc(macroObservations.observationPeriod), asc(macroObservations.revisionNo));
  return rows.map(toStoredObservation);
}

export async function insertMacroObservationVersion(input: MacroObservationInput): Promise<boolean> {
  const db = getDb();
  const [latest] = await db.select().from(macroObservations)
    .where(and(
      eq(macroObservations.seriesKey, input.seriesKey),
      eq(macroObservations.observationPeriod, input.observationPeriod),
    ))
    .orderBy(desc(macroObservations.revisionNo))
    .limit(1);
  if (latest?.sourceChecksum === input.sourceChecksum) return false;
  await db.insert(macroObservations).values({
    ...input,
    publishedAt: input.publishedAt ? toMysqlUtc(input.publishedAt) : null,
    availableAt: toMysqlUtc(input.availableAt),
    fetchedAt: toMysqlUtc(input.fetchedAt),
    revisionNo: (latest?.revisionNo ?? 0) + 1,
    status: latest ? 'revised' : input.status,
  }).onDuplicateKeyUpdate({ set: { fetchedAt: toMysqlUtc(input.fetchedAt) } });
  return true;
}

export async function listLatestAvailableMacroObservations(
  seriesKey: string,
  availableAtIso: string,
): Promise<StoredMacroObservation[]> {
  const rows = await getDb().select().from(macroObservations)
    .where(and(
      eq(macroObservations.seriesKey, seriesKey),
      lte(macroObservations.availableAt, toMysqlUtc(availableAtIso)),
    ))
    .orderBy(asc(macroObservations.observationPeriod), desc(macroObservations.revisionNo));
  const latestByPeriod = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!latestByPeriod.has(row.observationPeriod)) latestByPeriod.set(row.observationPeriod, row);
  }
  return [...latestByPeriod.values()].map(toStoredObservation);
}

function toStoredObservation(row: typeof macroObservations.$inferSelect): StoredMacroObservation {
  return {
    id: row.id,
    seriesKey: row.seriesKey,
    observationPeriod: row.observationPeriod,
    value: row.value,
    publishedAt: row.publishedAt ? mysqlUtcToIso(row.publishedAt) : null,
    availableAt: mysqlUtcToIso(row.availableAt),
    fetchedAt: mysqlUtcToIso(row.fetchedAt),
    sourceKey: row.sourceKey,
    authorityKey: row.authorityKey,
    sourceUrl: row.sourceUrl,
    sourceChecksum: row.sourceChecksum,
    revisionNo: row.revisionNo,
    status: row.status as MacroObservationInput['status'],
  };
}

function toMysqlUtc(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
}

function mysqlUtcToIso(value: string): string {
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}
