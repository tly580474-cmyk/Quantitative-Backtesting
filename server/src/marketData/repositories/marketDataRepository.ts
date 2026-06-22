import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type {
  DailyCandle,
  AdjustmentFactorRecord,
  MarketDataVersion,
  DataFreshness,
} from '../../marketData/types.js';

const { dailyCandles, adjustmentFactors, marketDataVersions } = schema;
const CHUNK_SIZE = 500;

// ─── Daily Candles ──────────────────────────────────────────────────

export async function getDailyCandles(
  instrumentId: string,
  options?: {
    startDate?: string;
    endDate?: string;
    offset?: number;
    limit?: number;
  },
): Promise<{ data: DailyCandle[]; total: number }> {
  const conditions: ReturnType<typeof eq>[] = [
    eq(dailyCandles.instrumentId, instrumentId),
  ];

  if (options?.startDate) conditions.push(gte(dailyCandles.tradeDate, options.startDate));
  if (options?.endDate) conditions.push(lte(dailyCandles.tradeDate, options.endDate));

  const where = and(...conditions);

  const _offset = options?.offset ?? 0;
  const _limit = options?.limit ?? 500;

  const [data, [countRow]] = await Promise.all([
    getDb()
      .select()
      .from(dailyCandles)
      .where(where)
      .orderBy(dailyCandles.tradeDate)
      .limit(_limit)
      .offset(_offset),
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(dailyCandles)
      .where(where),
  ]);

  return { data: data as DailyCandle[], total: Number(countRow?.count ?? 0) };
}

export async function upsertDailyCandles(
  candles: DailyCandle[],
): Promise<void> {
  await getDb().transaction(async (tx) => {
    for (let i = 0; i < candles.length; i += CHUNK_SIZE) {
      await tx
        .insert(dailyCandles)
        .values(candles.slice(i, i + CHUNK_SIZE))
        .onDuplicateKeyUpdate({
          set: {
            open: sql`VALUES(${dailyCandles.open})`,
            high: sql`VALUES(${dailyCandles.high})`,
            low: sql`VALUES(${dailyCandles.low})`,
            close: sql`VALUES(${dailyCandles.close})`,
            volume: sql`VALUES(${dailyCandles.volume})`,
            turnover: sql`VALUES(${dailyCandles.turnover})`,
            sourceVersion: sql`VALUES(${dailyCandles.sourceVersion})`,
            fetchedAt: sql`VALUES(${dailyCandles.fetchedAt})`,
          },
        });
    }
  });
}

// ─── Adjustment Factors ─────────────────────────────────────────────

export async function getAdjustmentFactors(
  instrumentId: string,
  startDate?: string,
  endDate?: string,
): Promise<AdjustmentFactorRecord[]> {
  const conditions: ReturnType<typeof eq>[] = [
    eq(adjustmentFactors.instrumentId, instrumentId),
  ];

  if (startDate) conditions.push(gte(adjustmentFactors.tradeDate, startDate));
  if (endDate) conditions.push(lte(adjustmentFactors.tradeDate, endDate));

  const where = and(...conditions);

  const rows = await getDb()
    .select()
    .from(adjustmentFactors)
    .where(where)
    .orderBy(adjustmentFactors.tradeDate);

  return rows as AdjustmentFactorRecord[];
}

export async function upsertAdjustmentFactors(
  factors: AdjustmentFactorRecord[],
): Promise<void> {
  await getDb().transaction(async (tx) => {
    for (let i = 0; i < factors.length; i += CHUNK_SIZE) {
      await tx
        .insert(adjustmentFactors)
        .values(factors.slice(i, i + CHUNK_SIZE))
        .onDuplicateKeyUpdate({
          set: {
            factor: sql`VALUES(${adjustmentFactors.factor})`,
            fetchedAt: sql`VALUES(${adjustmentFactors.fetchedAt})`,
          },
        });
    }
  });
}

// ─── Market Data Versions ───────────────────────────────────────────

export async function createMarketDataVersion(
  version: MarketDataVersion,
): Promise<void> {
  await getDb().insert(marketDataVersions).values(version);
}

export async function getLatestVersion(
  instrumentId: string,
): Promise<MarketDataVersion | null> {
  const rows = await getDb()
    .select()
    .from(marketDataVersions)
    .where(eq(marketDataVersions.instrumentId, instrumentId))
    .orderBy(desc(marketDataVersions.createdAt))
    .limit(1);

  return (rows[0] as MarketDataVersion) ?? null;
}

// ─── Data Freshness ─────────────────────────────────────────────────

export async function getDataFreshness(): Promise<DataFreshness> {
  const [
    [instrumentCount],
    [syncedCount],
    [latestDate],
    [failedSync],
    [openIssues],
  ] = await Promise.all([
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(schema.instruments),
    getDb()
      .select({
        count: sql<number>`count(distinct ${dailyCandles.instrumentId})`,
      })
      .from(dailyCandles),
    getDb()
      .select({ tradeDate: dailyCandles.tradeDate })
      .from(dailyCandles)
      .orderBy(desc(dailyCandles.tradeDate))
      .limit(1),
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(schema.syncJobItems)
      .where(eq(schema.syncJobItems.status, 'failed')),
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(schema.dataQualityIssues)
      .where(eq(schema.dataQualityIssues.status, 'open')),
  ]);

  const [pendingItems] = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(schema.syncJobItems)
    .where(eq(schema.syncJobItems.status, 'pending'));

  return {
    totalInstruments: Number(instrumentCount?.count ?? 0),
    syncedInstruments: Number(syncedCount?.count ?? 0),
    latestTradeDate: latestDate?.tradeDate ?? null,
    pendingTradeDates: Number(pendingItems?.count ?? 0),
    failedSyncCount: Number(failedSync?.count ?? 0),
    openIssueCount: Number(openIssues?.count ?? 0),
  };
}
