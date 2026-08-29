import { and, desc, eq, ne } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import {
  MARKET_HEALTH_INDICATOR_KEYS,
  type MarketHealthIndicatorKey,
  type MarketHealthPublicationStatus,
  type MarketHealthSnapshotInput,
} from './types.js';

const { marketHealthSnapshots } = schema;

export interface StoredMarketHealthSnapshot extends Omit<MarketHealthSnapshotInput, 'publicationStatus'> {
  id: number;
  publicationStatus: MarketHealthPublicationStatus;
}

export async function listLatestPublishedMarketHealthSnapshots(): Promise<StoredMarketHealthSnapshot[]> {
  const rows = await Promise.all(MARKET_HEALTH_INDICATOR_KEYS.map(async (indicatorKey) => {
    const [row] = await getDb().select().from(marketHealthSnapshots)
      .where(and(
        eq(marketHealthSnapshots.indicatorKey, indicatorKey),
        ne(marketHealthSnapshots.publicationStatus, 'superseded'),
      ))
      .orderBy(
        desc(marketHealthSnapshots.asOfDate),
        desc(marketHealthSnapshots.publicationStatus),
        desc(marketHealthSnapshots.calculatedAt),
      )
      .limit(1);
    return row;
  }));
  return rows.filter((row): row is NonNullable<typeof row> => Boolean(row)).map(toStoredSnapshot);
}

export async function getLatestMarketHealthSnapshot(
  indicatorKey: MarketHealthIndicatorKey,
): Promise<StoredMarketHealthSnapshot | null> {
  const [row] = await getDb().select().from(marketHealthSnapshots)
    .where(and(
      eq(marketHealthSnapshots.indicatorKey, indicatorKey),
      ne(marketHealthSnapshots.publicationStatus, 'superseded'),
    ))
    .orderBy(desc(marketHealthSnapshots.asOfDate), desc(marketHealthSnapshots.calculatedAt))
    .limit(1);
  return row ? toStoredSnapshot(row) : null;
}

export async function listMarketHealthSnapshotHistory(
  indicatorKey: MarketHealthIndicatorKey,
  modelVersion: string,
  limit = 24,
): Promise<StoredMarketHealthSnapshot[]> {
  const rows = await getDb().select().from(marketHealthSnapshots)
    .where(and(
      eq(marketHealthSnapshots.indicatorKey, indicatorKey),
      eq(marketHealthSnapshots.modelVersion, modelVersion),
      ne(marketHealthSnapshots.publicationStatus, 'pending'),
    ))
    .orderBy(desc(marketHealthSnapshots.asOfDate), desc(marketHealthSnapshots.calculatedAt))
    .limit(Math.min(60, Math.max(1, limit)));
  return rows.map(toStoredSnapshot).reverse();
}

export async function publishMarketHealthSnapshot(input: MarketHealthSnapshotInput): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.insert(marketHealthSnapshots).values({
      indicatorKey: input.indicatorKey,
      asOfDate: input.asOfDate,
      periodKey: input.periodKey,
      score: input.score,
      statusLabel: input.statusLabel,
      interpretation: input.interpretation,
      direction: input.direction,
      frequency: input.frequency,
      modelVersion: input.modelVersion,
      components: input.components,
      sourcePeriods: input.sourcePeriods,
      coveragePct: input.coveragePct,
      sourceSnapshotId: input.sourceSnapshotId,
      calculatedAt: toMysqlUtc(input.calculatedAt),
      publicationStatus: input.publicationStatus,
      staleAfter: input.staleAfter ? toMysqlUtc(input.staleAfter) : null,
    }).onDuplicateKeyUpdate({ set: {
      periodKey: input.periodKey,
      score: input.score,
      statusLabel: input.statusLabel,
      interpretation: input.interpretation,
      direction: input.direction,
      frequency: input.frequency,
      components: input.components,
      sourcePeriods: input.sourcePeriods,
      coveragePct: input.coveragePct,
      sourceSnapshotId: input.sourceSnapshotId,
      calculatedAt: toMysqlUtc(input.calculatedAt),
      publicationStatus: input.publicationStatus,
      staleAfter: input.staleAfter ? toMysqlUtc(input.staleAfter) : null,
    } });

    await tx.update(marketHealthSnapshots).set({ publicationStatus: 'superseded' })
      .where(and(
        eq(marketHealthSnapshots.indicatorKey, input.indicatorKey),
        ne(marketHealthSnapshots.asOfDate, input.asOfDate),
        eq(marketHealthSnapshots.publicationStatus, input.publicationStatus),
      ));
  });
}

function toStoredSnapshot(row: typeof marketHealthSnapshots.$inferSelect): StoredMarketHealthSnapshot {
  return {
    id: row.id,
    indicatorKey: row.indicatorKey as MarketHealthIndicatorKey,
    asOfDate: row.asOfDate,
    periodKey: row.periodKey,
    score: row.score,
    statusLabel: row.statusLabel,
    interpretation: row.interpretation,
    direction: row.direction as StoredMarketHealthSnapshot['direction'],
    frequency: row.frequency as StoredMarketHealthSnapshot['frequency'],
    modelVersion: row.modelVersion,
    components: row.components as StoredMarketHealthSnapshot['components'],
    sourcePeriods: row.sourcePeriods as StoredMarketHealthSnapshot['sourcePeriods'],
    coveragePct: row.coveragePct,
    sourceSnapshotId: row.sourceSnapshotId,
    calculatedAt: mysqlUtcToIso(row.calculatedAt),
    publicationStatus: row.publicationStatus as MarketHealthPublicationStatus,
    staleAfter: row.staleAfter ? mysqlUtcToIso(row.staleAfter) : null,
  };
}

function mysqlUtcToIso(value: string): string {
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}

function toMysqlUtc(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
}
