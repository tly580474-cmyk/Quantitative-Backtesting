import { eq, and, gte, lte, lt, desc, inArray, isNotNull, sql, max } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { CompressedFactor } from '../../historyImport/factor.js';
import type {
  DailyCandle,
  AdjustmentFactorRecord,
  MarketDataVersion,
  DataFreshness,
} from '../../marketData/types.js';
import { getHistoryStorePolicy } from './historyStorePolicy.js';

const {
  dailyCandles,
  adjustmentFactors,
  marketDataVersions,
  dailyBarsV2,
  dailyStockMetrics,
  instruments,
  adjustmentFactorsV2,
  adjustedBarOverrides,
  dataImportBatches,
  dataQualityIssues,
  adjustmentFactorPublications,
  corporateActions,
} = schema;
const CHUNK_SIZE = 500;

export interface HistoryDailyBarUpsert {
  instrumentKey: number;
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  previousClose?: number | null;
  volume?: number | null;
  amount?: number | null;
  turnoverRatePct?: number | null;
  sourceKey: number;
  sourceVersion: string;
  fetchedAt: string;
  isFinal: boolean;
}

export interface DailyStockMetricUpsert {
  instrumentKey: number;
  tradeDate: string;
  totalShares?: number | null;
  floatShares?: number | null;
  totalMarketCap?: number | null;
  floatMarketCap?: number | null;
  peTtm?: number | null;
  pb?: number | null;
  psTtm?: number | null;
  volumeRatio?: number | null;
  isSt: boolean;
  isLimitUp: boolean;
}

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

export async function getInstrumentDataSummaries(instrumentIds: string[]) {
  if (instrumentIds.length === 0) return [];
  return getDb()
    .select({
      instrumentId: dailyCandles.instrumentId,
      startDate: sql<string>`min(${dailyCandles.tradeDate})`,
      endDate: sql<string>`max(${dailyCandles.tradeDate})`,
      recordCount: sql<number>`count(*)`,
    })
    .from(dailyCandles)
    .where(inArray(dailyCandles.instrumentId, instrumentIds))
    .groupBy(dailyCandles.instrumentId);
}

export async function getHistoryInstrumentSummaries(instrumentIds: string[]) {
  if (instrumentIds.length === 0) return [];
  return getDb()
    .select({
      instrumentId: instruments.id,
      startDate: sql<string>`min(${dailyBarsV2.tradeDate})`,
      endDate: sql<string>`max(${dailyBarsV2.tradeDate})`,
      recordCount: sql<number>`count(*)`,
    })
    .from(instruments)
    .innerJoin(
      dailyBarsV2,
      eq(dailyBarsV2.instrumentKey, instruments.instrumentKey),
    )
    .where(inArray(instruments.id, instrumentIds))
    .groupBy(instruments.id);
}

export async function getHistoryDailyBars(
  instrumentKey: number,
  options?: {
    startDate?: string;
    endDate?: string;
    offset?: number;
    limit?: number;
  },
) {
  const conditions = [eq(dailyBarsV2.instrumentKey, instrumentKey)];
  if (options?.startDate) conditions.push(gte(dailyBarsV2.tradeDate, options.startDate));
  if (options?.endDate) conditions.push(lte(dailyBarsV2.tradeDate, options.endDate));
  const where = and(...conditions);
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 500;

  const [data, [countRow]] = await Promise.all([
    getDb()
      .select()
      .from(dailyBarsV2)
      .where(where)
      .orderBy(dailyBarsV2.tradeDate)
      .limit(limit)
      .offset(offset),
    getDb()
      .select({ count: sql<number>`count(*)` })
      .from(dailyBarsV2)
      .where(where),
  ]);
  return { data, total: Number(countRow?.count ?? 0) };
}

export async function getLatestHistoryDailyBar(instrumentKey: number) {
  const [row] = await getDb()
    .select()
    .from(dailyBarsV2)
    .where(eq(dailyBarsV2.instrumentKey, instrumentKey))
    .orderBy(desc(dailyBarsV2.tradeDate))
    .limit(1);
  return row ?? null;
}

export async function getLatestHistoryDailyBars(
  instrumentKeys: number[],
) {
  return getLatestHistoryDailyBarsMatching(instrumentKeys);
}

export async function getLatestHistoryDailyBarsBefore(
  instrumentKeys: number[],
  beforeDate: string,
) {
  return getLatestHistoryDailyBarsMatching(instrumentKeys, beforeDate);
}

async function getLatestHistoryDailyBarsMatching(
  instrumentKeys: number[],
  beforeDate?: string,
) {
  if (instrumentKeys.length === 0) return [];
  const result: Array<typeof dailyBarsV2.$inferSelect> = [];
  for (let index = 0; index < instrumentKeys.length; index += 1000) {
    const keys = instrumentKeys.slice(index, index + 1000);
    const latestDates = getDb()
      .select({
        instrumentKey: dailyBarsV2.instrumentKey,
        latestTradeDate: max(dailyBarsV2.tradeDate).as('latest_trade_date'),
      })
      .from(dailyBarsV2)
      .where(and(
        inArray(dailyBarsV2.instrumentKey, keys),
        beforeDate ? lt(dailyBarsV2.tradeDate, beforeDate) : undefined,
      ))
      .groupBy(dailyBarsV2.instrumentKey)
      .as('latest_dates');
    result.push(...await getDb()
      .select({
        instrumentKey: dailyBarsV2.instrumentKey,
        tradeDate: dailyBarsV2.tradeDate,
        open: dailyBarsV2.open,
        high: dailyBarsV2.high,
        low: dailyBarsV2.low,
        close: dailyBarsV2.close,
        previousClose: dailyBarsV2.previousClose,
        volume: dailyBarsV2.volume,
        amount: dailyBarsV2.amount,
        turnoverRatePct: dailyBarsV2.turnoverRatePct,
        sourceKey: dailyBarsV2.sourceKey,
        sourceVersion: dailyBarsV2.sourceVersion,
        fetchedAt: dailyBarsV2.fetchedAt,
        isFinal: dailyBarsV2.isFinal,
      })
      .from(dailyBarsV2)
      .innerJoin(
        latestDates,
        and(
          eq(dailyBarsV2.instrumentKey, latestDates.instrumentKey),
          eq(dailyBarsV2.tradeDate, latestDates.latestTradeDate),
        ),
      ));
  }
  return result;
}

export async function getHistoryDailyBarsInRange(
  instrumentKey: number,
  startDate: string,
  endDate: string,
) {
  return getDb()
    .select()
    .from(dailyBarsV2)
    .where(and(
      eq(dailyBarsV2.instrumentKey, instrumentKey),
      gte(dailyBarsV2.tradeDate, startDate),
      lte(dailyBarsV2.tradeDate, endDate),
    ))
    .orderBy(dailyBarsV2.tradeDate);
}

export async function upsertHistoryDailyBars(
  bars: HistoryDailyBarUpsert[],
): Promise<void> {
  if (bars.length === 0) return;
  await getDb().transaction(async (tx) => {
    for (let index = 0; index < bars.length; index += CHUNK_SIZE) {
      const rows = bars.slice(index, index + CHUNK_SIZE).map((bar) => ({
        ...bar,
        isFinal: bar.isFinal ? 1 : 0,
      }));
      await tx
        .insert(dailyBarsV2)
        .values(rows)
        .onDuplicateKeyUpdate({
          set: {
            open: sql`VALUES(${dailyBarsV2.open})`,
            high: sql`VALUES(${dailyBarsV2.high})`,
            low: sql`VALUES(${dailyBarsV2.low})`,
            close: sql`VALUES(${dailyBarsV2.close})`,
            previousClose: sql`COALESCE(VALUES(${dailyBarsV2.previousClose}), ${dailyBarsV2.previousClose})`,
            volume: sql`VALUES(${dailyBarsV2.volume})`,
            amount: sql`COALESCE(VALUES(${dailyBarsV2.amount}), ${dailyBarsV2.amount})`,
            turnoverRatePct: sql`COALESCE(VALUES(${dailyBarsV2.turnoverRatePct}), ${dailyBarsV2.turnoverRatePct})`,
            sourceKey: sql`VALUES(${dailyBarsV2.sourceKey})`,
            sourceVersion: sql`VALUES(${dailyBarsV2.sourceVersion})`,
            fetchedAt: sql`VALUES(${dailyBarsV2.fetchedAt})`,
            isFinal: sql`VALUES(${dailyBarsV2.isFinal})`,
          },
        });
    }
  });
}

export async function upsertDailyStockMetrics(
  metrics: DailyStockMetricUpsert[],
): Promise<void> {
  if (metrics.length === 0) return;
  await getDb().transaction(async (tx) => {
    for (let index = 0; index < metrics.length; index += CHUNK_SIZE) {
      await tx
        .insert(dailyStockMetrics)
        .values(metrics.slice(index, index + CHUNK_SIZE).map((metric) => ({
          ...metric,
          isSt: metric.isSt ? 1 : 0,
          isLimitUp: metric.isLimitUp ? 1 : 0,
        })))
        .onDuplicateKeyUpdate({
          set: {
            totalShares: sql`COALESCE(VALUES(${dailyStockMetrics.totalShares}), ${dailyStockMetrics.totalShares})`,
            floatShares: sql`COALESCE(VALUES(${dailyStockMetrics.floatShares}), ${dailyStockMetrics.floatShares})`,
            totalMarketCap: sql`COALESCE(VALUES(${dailyStockMetrics.totalMarketCap}), ${dailyStockMetrics.totalMarketCap})`,
            floatMarketCap: sql`COALESCE(VALUES(${dailyStockMetrics.floatMarketCap}), ${dailyStockMetrics.floatMarketCap})`,
            peTtm: sql`COALESCE(VALUES(${dailyStockMetrics.peTtm}), ${dailyStockMetrics.peTtm})`,
            pb: sql`COALESCE(VALUES(${dailyStockMetrics.pb}), ${dailyStockMetrics.pb})`,
            psTtm: sql`COALESCE(VALUES(${dailyStockMetrics.psTtm}), ${dailyStockMetrics.psTtm})`,
            volumeRatio: sql`COALESCE(VALUES(${dailyStockMetrics.volumeRatio}), ${dailyStockMetrics.volumeRatio})`,
            isSt: sql`VALUES(${dailyStockMetrics.isSt})`,
            isLimitUp: sql`VALUES(${dailyStockMetrics.isLimitUp})`,
          },
        });
    }
  });
}

export async function getPublishedHistoryAdjustment(
  instrumentKey: number,
  instrumentId: string,
  mode: 'qfq' | 'hfq',
) {
  const [instrumentPublication] = await getDb()
    .select({
      factorVersion: adjustmentFactorPublications.factorVersion,
      publishedAt: adjustmentFactorPublications.publishedAt,
    })
    .from(adjustmentFactorPublications)
    .where(eq(adjustmentFactorPublications.instrumentKey, instrumentKey))
    .limit(1);
  const [legacyPublication] = instrumentPublication ? [] : await getDb()
    .select({
      factorVersion: adjustmentFactorsV2.factorVersion,
      publishedAt: dataImportBatches.publishedAt,
    })
    .from(adjustmentFactorsV2)
    .innerJoin(
      dataImportBatches,
      eq(adjustmentFactorsV2.sourceBatchId, dataImportBatches.id),
    )
    .where(isNotNull(dataImportBatches.publishedAt))
    .orderBy(desc(dataImportBatches.publishedAt))
    .limit(1);
  const published = instrumentPublication ?? legacyPublication;
  if (!published) return null;

  const [factors, overrides, warnings] = await Promise.all([
    getDb()
      .select({
        effectiveDate: adjustmentFactorsV2.effectiveDate,
        factor: adjustmentFactorsV2.factor,
        priceOffset: adjustmentFactorsV2.priceOffset,
      })
      .from(adjustmentFactorsV2)
      .where(and(
        eq(adjustmentFactorsV2.instrumentKey, instrumentKey),
        eq(adjustmentFactorsV2.factorVersion, published.factorVersion),
      ))
      .orderBy(adjustmentFactorsV2.effectiveDate),
    getDb()
      .select({
        tradeDate: adjustedBarOverrides.tradeDate,
        open: adjustedBarOverrides.open,
        high: adjustedBarOverrides.high,
        low: adjustedBarOverrides.low,
        close: adjustedBarOverrides.close,
      })
      .from(adjustedBarOverrides)
      .where(and(
        eq(adjustedBarOverrides.instrumentKey, instrumentKey),
        eq(adjustedBarOverrides.adjustmentMode, 'qfq'),
      ))
      .orderBy(adjustedBarOverrides.tradeDate),
    getDb()
      .select({
        ruleCode: dataQualityIssues.ruleCode,
        details: dataQualityIssues.details,
      })
      .from(dataQualityIssues)
      .where(and(
        eq(dataQualityIssues.instrumentId, instrumentId),
        eq(dataQualityIssues.status, 'open'),
        mode === 'qfq'
          ? eq(dataQualityIssues.ruleCode, 'ADJUSTMENT_QFQ_RECONSTRUCTION')
          : inArray(dataQualityIssues.ruleCode, [
              'ADJUSTMENT_QFQ_RECONSTRUCTION',
              'ADJUSTMENT_HFQ_CROSSCHECK',
            ]),
      )),
  ]);
  return {
    factorVersion: published.factorVersion,
    factors,
    overrides,
    warnings,
  };
}

export async function getPublishedFactorState(instrumentKey: number) {
  const [publication] = await getDb()
    .select()
    .from(adjustmentFactorPublications)
    .where(eq(adjustmentFactorPublications.instrumentKey, instrumentKey))
    .limit(1);
  if (!publication) return null;
  const factors = await getDb()
    .select({
      effectiveDate: adjustmentFactorsV2.effectiveDate,
      factor: adjustmentFactorsV2.factor,
      offset: adjustmentFactorsV2.priceOffset,
    })
    .from(adjustmentFactorsV2)
    .where(and(
      eq(adjustmentFactorsV2.instrumentKey, instrumentKey),
      eq(adjustmentFactorsV2.factorVersion, publication.factorVersion),
    ))
    .orderBy(adjustmentFactorsV2.effectiveDate);
  return { publication, factors };
}

export async function publishHistoryAdjustment(input: {
  instrumentKey: number;
  factorVersion: string;
  sourceBatchId: string;
  sourceRoot: string;
  sourceFingerprint: string;
  sourceKey: number;
  checkedDate: string;
  factors: CompressedFactor[];
  event?: {
    id: string;
    exDate: string;
    previousClose?: number | null;
    exReferencePrice?: number | null;
  };
  priorTransform: { factor: number; offset: number };
}): Promise<void> {
  const now = new Date().toISOString().slice(0, 23).replace('T', ' ');
  await getDb().transaction(async (tx) => {
    await tx.insert(dataImportBatches).values({
      id: input.sourceBatchId,
      sourceRoot: input.sourceRoot,
      sourceSnapshot: input.sourceFingerprint,
      status: 'completed',
      totalFiles: 1,
      completedFiles: 1,
      failedFiles: 0,
      totalRows: input.factors.length,
      importedRows: input.factors.length,
      startedAt: now,
      finishedAt: now,
      publishedAt: now,
    });

    for (let index = 0; index < input.factors.length; index += CHUNK_SIZE) {
      await tx.insert(adjustmentFactorsV2).values(
        input.factors.slice(index, index + CHUNK_SIZE).map((factor) => ({
          instrumentKey: input.instrumentKey,
          effectiveDate: factor.effectiveDate,
          factorVersion: input.factorVersion,
          factor: factor.factor,
          priceOffset: factor.offset,
          sourceKey: input.sourceKey,
          sourceBatchId: input.sourceBatchId,
        })),
      );
    }

    const transform = input.priorTransform;
    if (
      Math.abs(transform.factor - 1) > 1e-10
      || Math.abs(transform.offset) > 1e-10
    ) {
      await tx
        .update(adjustedBarOverrides)
        .set({
          open: sql`${adjustedBarOverrides.open} * ${transform.factor} + ${transform.offset}`,
          high: sql`${adjustedBarOverrides.high} * ${transform.factor} + ${transform.offset}`,
          low: sql`${adjustedBarOverrides.low} * ${transform.factor} + ${transform.offset}`,
          close: sql`${adjustedBarOverrides.close} * ${transform.factor} + ${transform.offset}`,
          sourceBatchId: input.sourceBatchId,
        })
        .where(and(
          eq(adjustedBarOverrides.instrumentKey, input.instrumentKey),
          eq(adjustedBarOverrides.adjustmentMode, 'qfq'),
        ));
    }

    if (input.event) {
      await tx
        .insert(corporateActions)
        .values({
          id: input.event.id,
          instrumentKey: input.instrumentKey,
          exDate: input.event.exDate,
          actionType: 'unknown',
          previousClose: input.event.previousClose,
          exReferencePrice: input.event.exReferencePrice,
          sourceKey: input.sourceKey,
          sourceFingerprint: input.sourceFingerprint,
          status: 'confirmed',
          detectedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            previousClose: sql`VALUES(${corporateActions.previousClose})`,
            exReferencePrice: sql`VALUES(${corporateActions.exReferencePrice})`,
            sourceFingerprint: sql`VALUES(${corporateActions.sourceFingerprint})`,
            status: 'confirmed',
            detectedAt: now,
          },
        });
    }

    await tx
      .insert(adjustmentFactorPublications)
      .values({
        instrumentKey: input.instrumentKey,
        factorVersion: input.factorVersion,
        sourceBatchId: input.sourceBatchId,
        sourceFingerprint: input.sourceFingerprint,
        lastCheckedDate: input.checkedDate,
        publishedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          factorVersion: input.factorVersion,
          sourceBatchId: input.sourceBatchId,
          sourceFingerprint: input.sourceFingerprint,
          lastCheckedDate: input.checkedDate,
          publishedAt: now,
        },
      });
  });
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
            turnoverRatePct: sql`VALUES(${dailyCandles.turnoverRatePct})`,
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
  const useV2 = getHistoryStorePolicy().readMode !== 'legacy';
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
    useV2
      ? getDb()
        .select({
          count: sql<number>`count(distinct ${dailyBarsV2.instrumentKey})`,
        })
        .from(dailyBarsV2)
      : getDb()
        .select({
          count: sql<number>`count(distinct ${dailyCandles.instrumentId})`,
        })
        .from(dailyCandles),
    useV2
      ? getDb()
        .select({ tradeDate: dailyBarsV2.tradeDate })
        .from(dailyBarsV2)
        .orderBy(desc(dailyBarsV2.tradeDate))
        .limit(1)
      : getDb()
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

export interface MarketSnapshotRow {
  instrumentKey: number;
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  price: number | null;
  changePct: number | null;
  amountYi: number | null;
  turnoverPct: number | null;
  amplitudePct: number | null;
  volumeRatio: number | null;
  isSt: boolean;
}

/**
 * 取全市场最新交易日（盘后/快照）的量价快照：JOIN instruments（名称/市场）、
 * daily_bars_v2 最新日（OHLC/成交额/换手率）、daily_stock_metrics 最新日（量比/ST）。
 * 涨跌幅与振幅由 OHLC 在内存推导（库里不存储这两个字段）。
 */
export async function getLatestMarketSnapshot(
  markets?: Array<'SH' | 'SZ' | 'BJ'>,
): Promise<MarketSnapshotRow[]> {
  const [latestRow] = await getDb()
    .select({ maxDate: sql<string>`MAX(${dailyBarsV2.tradeDate})` })
    .from(dailyBarsV2);
  const latestDate = latestRow?.maxDate;
  if (!latestDate) return [];

  const latestDates = getDb()
    .select({
      instrumentKey: dailyBarsV2.instrumentKey,
      latestTradeDate: max(dailyBarsV2.tradeDate).as('latest_trade_date'),
    })
    .from(dailyBarsV2)
    .groupBy(dailyBarsV2.instrumentKey)
    .as('latest_dates');

  const rows = await getDb()
    .select({
      instrumentKey: instruments.instrumentKey,
      code: instruments.symbol,
      name: instruments.name,
      market: instruments.market,
      price: dailyBarsV2.close,
      previousClose: dailyBarsV2.previousClose,
      high: dailyBarsV2.high,
      low: dailyBarsV2.low,
      amount: dailyBarsV2.amount,
      turnoverRatePct: dailyBarsV2.turnoverRatePct,
      volumeRatio: dailyStockMetrics.volumeRatio,
      isSt: dailyStockMetrics.isSt,
    })
    .from(instruments)
    .innerJoin(latestDates, eq(instruments.instrumentKey, latestDates.instrumentKey))
    .innerJoin(
      dailyBarsV2,
      and(
        eq(dailyBarsV2.instrumentKey, latestDates.instrumentKey),
        eq(dailyBarsV2.tradeDate, latestDates.latestTradeDate),
      ),
    )
    .leftJoin(
      dailyStockMetrics,
      and(
        eq(dailyStockMetrics.instrumentKey, latestDates.instrumentKey),
        eq(dailyStockMetrics.tradeDate, latestDates.latestTradeDate),
      ),
    )
    .where(markets && markets.length > 0 ? inArray(instruments.market, markets) : undefined);

  return rows.map((row) => {
    const prev = row.previousClose != null ? Number(row.previousClose) : null;
    const price = row.price != null ? Number(row.price) : null;
    const changePct = prev != null && prev > 0 && price != null ? (price / prev - 1) * 100 : null;
    const amplitudePct = prev != null && prev > 0
      ? ((Number(row.high) - Number(row.low)) / prev) * 100
      : null;
    return {
      instrumentKey: Number(row.instrumentKey),
      code: row.code,
      name: row.name,
      market: row.market as 'SH' | 'SZ' | 'BJ',
      price,
      changePct,
      amountYi: row.amount != null ? Number(row.amount) / 100_000_000 : null,
      turnoverPct: row.turnoverRatePct != null ? Number(row.turnoverRatePct) : null,
      amplitudePct,
      volumeRatio: row.volumeRatio != null ? Number(row.volumeRatio) : null,
      isSt: Number(row.isSt) === 1,
    };
  });
}

export async function getInstrumentKeyBySymbol(
  symbol: string,
  market: string,
): Promise<number | null> {
  const [row] = await getDb()
    .select({ instrumentKey: instruments.instrumentKey })
    .from(instruments)
    .where(and(eq(instruments.symbol, symbol), eq(instruments.market, market)))
    .limit(1);
  return row?.instrumentKey ?? null;
}
