// ─── Sync Executor ─────────────────────────────────────────────────
// Core sync execution engine. Orchestrates the full sync flow for all
// job types: instruments, calendar, history, and incremental.

import type { Instrument, SyncJob, TradingCalendarEntry } from '../types.js';
import type { MarketDataProvider, ProviderCandle } from '../providers/provider.js';
import { ProviderError } from '../providers/provider.js';
import { classifyError, calculateBackoff, shouldRetry } from './retryPolicy.js';
import { validateCandleSet } from '../quality/validators.js';
import { normalizeCandle, normalizeCandles } from '../normalization/candleNormalizer.js';
import { listProviders } from '../providers/providerRegistry.js';

import { listInstruments, upsertInstrument } from '../repositories/instrumentRepository.js';
import { getOpenTradingDays, upsertCalendarEntries } from '../repositories/calendarRepository.js';
import {
  getHistoryDailyBarsInRange,
  getLatestHistoryDailyBar,
  getLatestHistoryDailyBarsBefore,
  upsertDailyStockMetrics,
  upsertDailyCandles,
  upsertHistoryDailyBars,
} from '../repositories/marketDataRepository.js';
import { getHistoryStorePolicy } from '../repositories/historyStorePolicy.js';
import {
  getSyncJob,
  updateSyncJobStatus,
  updateSyncJobCounts,
  updateSyncJobItem,
  createSyncJobItems,
  getSyncJobItems,
  getPendingItems,
  updateSyncJobItemsStatus,
} from '../repositories/syncJobRepository.js';
import { createQualityIssue } from '../repositories/dataQualityRepository.js';
import { getChinaMarketSession } from './marketSession.js';
import { hasCorporateActionSignal } from './adjustmentRefresh.js';
import {
  refreshAdjustmentAfterCorporateAction,
  sourceKeyForProvider,
} from './factorRefreshService.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  totalProcessed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ symbol: string; error: string }>;
}

interface SymbolError {
  symbol: string;
  error: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const CHUNK_SIZE = 10;
const SOURCE_VERSION = '1';

// ─── Main Executor ──────────────────────────────────────────────────

/**
 * Executes a sync job from start to finish.
 *
 * Handles all four job types:
 * - instruments: fetch and upsert instrument definitions
 * - calendar: fetch and upsert trading calendar entries
 * - history: fetch full candle history for specified symbols
 * - incremental: fetch new candles since last stored date
 *
 * The function is cancellation-aware: it checks the job status before
 * processing each symbol/chunk and stops if the job was cancelled.
 * Individual symbol failures are logged and recorded but never abort
 * the entire batch.
 */
export async function executeSyncJob(
  job: SyncJob,
  provider: MarketDataProvider,
): Promise<SyncResult> {
  const symbolErrors: SymbolError[] = [];
  let totalProcessed = 0;
  let succeeded = 0;
  let failed = 0;

  // Mark job as running
  await updateSyncJobStatus(job.id, 'running', new Date().toISOString());

  try {
    switch (job.jobType) {
      case 'instruments': {
        await executeInstrumentsSync(
          job,
          provider,
          (err) => {
            symbolErrors.push(err);
            failed++;
          },
          () => succeeded++,
          () => totalProcessed++,
        );
        break;
      }

      case 'calendar': {
        await executeCalendarSync(
          job,
          provider,
          (err) => {
            symbolErrors.push(err);
            failed++;
          },
          () => succeeded++,
          () => totalProcessed++,
        );
        break;
      }

      case 'history': {
        await executeHistorySync(
          job,
          provider,
          (err) => {
            symbolErrors.push(err);
            failed++;
          },
          () => succeeded++,
          () => totalProcessed++,
        );
        break;
      }

      case 'incremental': {
        await executeIncrementalSync(
          job,
          provider,
          (err) => {
            symbolErrors.push(err);
            failed++;
          },
          () => succeeded++,
          () => totalProcessed++,
        );
        break;
      }

      default:
        throw new Error(`Unknown job type: ${job.jobType}`);
    }

    // Check if cancelled during execution
    const currentJob = await getSyncJob(job.id);
    if (currentJob?.status === 'cancelled') {
      return {
        success: false,
        totalProcessed,
        succeeded,
        failed,
        errors: symbolErrors,
      };
    }

    await updateSyncJobCounts(job.id, totalProcessed, succeeded, failed);

    // A job with failed symbols must not masquerade as completed.
    await updateSyncJobStatus(
      job.id,
      failed > 0 ? 'failed' : 'completed',
      undefined,
      new Date().toISOString(),
    );

    return {
      success: failed === 0,
      totalProcessed,
      succeeded,
      failed,
      errors: symbolErrors,
    };
  } catch (err) {
    // Catastrophic error — mark job as failed
    const message = err instanceof Error ? err.message : String(err);
    await updateSyncJobStatus(job.id, 'failed', undefined, new Date().toISOString());

    return {
      success: false,
      totalProcessed,
      succeeded,
      failed: failed + 1,
      errors: [
        ...symbolErrors,
        { symbol: '__job__', error: message },
      ],
    };
  }
}

// ─── Job Type Handlers ──────────────────────────────────────────────

async function executeInstrumentsSync(
  job: SyncJob,
  provider: MarketDataProvider,
  onError: (err: SymbolError) => void,
  onSuccess: () => void,
  onProcessed: () => void,
): Promise<void> {
  const { market } = job.requestSnapshot;
  let cursor: string | undefined;

  // Try the active provider first; if it returns empty, try others.
  // Some providers (e.g. Tencent) only support single-symbol lookups.
  let effectiveProvider = provider;
  let firstPage = await provider.fetchInstruments({ market, cursor, pageSize: 100 });
  if (firstPage.items.length === 0 && firstPage.hasMore === false) {
    for (const fallback of listProviders()) {
      if (fallback.id === provider.id) continue;
      const page = await fallback.fetchInstruments({ market, cursor, pageSize: 100 });
      if (page.items.length > 0 || page.hasMore) {
        effectiveProvider = fallback;
        firstPage = page;
        break;
      }
    }
  }

  do {
    if (await isJobCancelled(job.id)) {
      await skipRemainingItems(job.id);
      return;
    }

    const page = cursor
      ? await effectiveProvider.fetchInstruments({ market, cursor, pageSize: 100 })
      : firstPage;

    for (const item of page.items) {
      try {
        await upsertInstrument({
          id: crypto.randomUUID(),
          market: item.market as never,
          symbol: item.symbol,
          name: item.name,
          type: item.type as never,
          listDate: item.listDate,
          delistDate: item.delistDate,
          status: item.delistDate ? 'delisted' : 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // Record provider symbol mapping is handled inside the
        // repository or a separate mapping call — for now we track
        // success at the item level
        onSuccess();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onError({ symbol: item.symbol, error: message });
      }
      onProcessed();
    }

    cursor = page.cursor;
  } while (cursor);

  // Update job progress
  await updateSyncJobProgress(job.id);
}

async function executeCalendarSync(
  job: SyncJob,
  provider: MarketDataProvider,
  onError: (err: SymbolError) => void,
  onSuccess: () => void,
  onProcessed: () => void,
): Promise<void> {
  const { market, startDate, endDate } = job.requestSnapshot;

  if (!market) {
    throw new Error('Market is required for calendar sync');
  }

  const tradingDays = await provider.fetchTradingCalendar({
    market,
    startDate: startDate ?? '1990-01-01',
    endDate: endDate ?? new Date().toISOString().slice(0, 10),
  });

  try {
    await upsertCalendarEntries(
      tradingDays.map((d) => ({
        id: crypto.randomUUID(),
        market: market as TradingCalendarEntry['market'],
        tradeDate: d.date,
        isOpen: d.isOpen,
        sessionMetadata: d.sessionMetadata,
      })),
      job.providerId,
    );
    onSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError({ symbol: `calendar:${market}`, error: message });
  }
  onProcessed();

  await updateSyncJobProgress(job.id);
}

async function executeHistorySync(
  job: SyncJob,
  provider: MarketDataProvider,
  onError: (err: SymbolError) => void,
  onSuccess: () => void,
  onProcessed: () => void,
): Promise<void> {
  const { market, symbols, startDate, endDate } = job.requestSnapshot;

  // Resolve symbols to process
  const targetSymbols = await resolveSymbols(market, symbols);

  for (let i = 0; i < targetSymbols.length; i++) {
    if (await isJobCancelled(job.id)) {
      await skipRemainingItems(job.id);
      return;
    }

    const symbol = targetSymbols[i];
    const itemId = crypto.randomUUID();
    await createSyncJobItems([{
      id: itemId,
      jobId: job.id,
      instrumentId: symbol,
      status: 'running',
      attempts: 1,
    }]);
    try {
      await processSymbolCandles(
        symbol,
        startDate ?? '1990-01-01',
        endDate ?? new Date().toISOString().slice(0, 10),
        job,
        provider,
      );
      await updateSyncJobItem(itemId, { status: 'completed' });
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateSyncJobItem(itemId, {
        status: 'failed',
        errorCode: err instanceof ProviderError ? err.category : 'data_error',
        errorMessage: message,
      });
      onError({ symbol, error: message });
    }
    onProcessed();

    // Update job progress periodically (every chunk or at end)
    if ((i + 1) % CHUNK_SIZE === 0 || i === targetSymbols.length - 1) {
      await updateSyncJobProgress(job.id);
    }
  }
}

async function executeIncrementalSync(
  job: SyncJob,
  provider: MarketDataProvider,
  onError: (err: SymbolError) => void,
  onSuccess: () => void,
  onProcessed: () => void,
): Promise<void> {
  const { market, markets, symbols } = job.requestSnapshot;
  const targets = await resolveIncrementalTargets(market, markets, symbols);
  const session = getChinaMarketSession();
  const today = session.tradeDate;
  const finalizeDailyBar = job.requestSnapshot.finalizeDailyBar
    ?? session.isDailyBarFinal;
  const itemIdByInstrumentId = new Map(
    targets.map((instrument) => [instrument.id, crypto.randomUUID()]),
  );
  await createSyncJobItems(targets.map((instrument) => ({
    id: itemIdByInstrumentId.get(instrument.id)!,
    jobId: job.id,
    instrumentId: instrument.id,
    status: 'pending',
    attempts: 1,
  })));
  await updateSyncJobCounts(job.id, targets.length, 0, 0);
  if (await isJobCancelled(job.id)) {
    await skipRemainingItems(job.id);
    return;
  }

  const keyedTargets = targets.filter(
    (instrument): instrument is Instrument & { instrumentKey: number } =>
      instrument.instrumentKey != null,
  );
  const failures = new Map<string, string>();
  for (const instrument of targets) {
    if (instrument.instrumentKey == null) {
      failures.set(instrument.id, `Instrument key missing: ${instrument.symbol}`);
    }
  }

  const previousBars = await getLatestHistoryDailyBarsBefore(
    keyedTargets.map((instrument) => instrument.instrumentKey),
    today,
  );
  const previousBarByKey = new Map(
    previousBars.map((bar) => [bar.instrumentKey, bar]),
  );
  const priorOpenDateByMarket = await getPriorOpenDateByMarket(
    [...new Set(keyedTargets.map((instrument) => instrument.market))],
    today,
  );

  const quoteBySymbol = new Map<string, ProviderCandle>();
  if (provider.fetchCurrentDailyCandles) {
    try {
      const rows = await fetchWithRetry(
        () => provider.fetchCurrentDailyCandles!({
          instruments: keyedTargets.map((instrument) => ({
            symbol: instrument.symbol,
            market: instrument.market,
          })),
        }),
        'fetchCurrentDailyCandles',
      );
      for (const quote of rows) {
        if (quote.date === today) quoteBySymbol.set(quote.symbol, quote);
      }
    } catch (error) {
      console.warn(
        `[syncExecutor] 全市场批量行情不可用，改为分片补取：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const missingTargets = keyedTargets.filter(
    (instrument) => !quoteBySymbol.has(instrument.symbol),
  );
  if (provider.fetchCurrentDailyCandles && missingTargets.length > 0) {
    const retryResult = await fetchCurrentQuotesInChunks(
      provider,
      missingTargets,
      today,
    );
    for (const quote of retryResult.quotes) {
      quoteBySymbol.set(quote.symbol, quote);
    }
    for (const failure of retryResult.failures) {
      failures.set(failure.instrument.id, failure.message);
    }
  }

  const quoteUpdates: Array<{
    instrument: Instrument & { instrumentKey: number };
    quote: ProviderCandle;
  }> = [];
  const gapUpdates: Array<{
    instrument: Instrument & { instrumentKey: number };
    startDate: string;
    endDate: string;
  }> = [];
  for (const instrument of keyedTargets) {
    if (failures.has(instrument.id)) continue;
    const quote = quoteBySymbol.get(instrument.symbol);
    if (!quote) continue; // No quote means no trade today (e.g. suspension).
    if (quote.turnover == null || quote.turnoverRatePct == null) {
      failures.set(
        instrument.id,
        `${instrument.symbol} 当日行情缺少成交额或换手率，拒绝写入不完整日线`,
      );
      continue;
    }
    quoteUpdates.push({ instrument, quote });
    const prior = previousBarByKey.get(instrument.instrumentKey);
    const priorOpenDate = priorOpenDateByMarket.get(instrument.market);
    if (
      priorOpenDate
      && (!prior || prior.tradeDate < priorOpenDate)
    ) {
      gapUpdates.push({
        instrument,
        startDate: prior ? incrementDate(prior.tradeDate) : (instrument.listDate ?? '2010-01-01'),
        endDate: priorOpenDate,
      });
    }
  }

  const fetchedAt = new Date().toISOString().slice(0, 23).replace('T', ' ');
  const normalized = quoteUpdates.map(({ instrument, quote }) =>
    normalizeCandle(quote, instrument.id, job.providerId));
  const historyRows = quoteUpdates.map(({ instrument, quote }) => ({
    instrumentKey: instrument.instrumentKey,
    tradeDate: quote.date,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    close: quote.close,
    previousClose: quote.previousClose,
    volume: quote.volume,
    amount: quote.turnover,
    turnoverRatePct: quote.turnoverRatePct,
    sourceKey: sourceKeyForProvider(provider.id),
    sourceVersion: `${SOURCE_VERSION}:${provider.id}`,
    fetchedAt,
    isFinal: finalizeDailyBar,
  }));
  const metricRows = quoteUpdates.map(({ instrument, quote }) => ({
    instrumentKey: instrument.instrumentKey,
    tradeDate: quote.date,
    totalShares: deriveShares(quote.totalMarketCap, quote.close),
    floatShares: deriveShares(quote.floatMarketCap, quote.close),
    totalMarketCap: quote.totalMarketCap,
    floatMarketCap: quote.floatMarketCap,
    peTtm: quote.peTtm,
    pb: quote.pb,
    psTtm: null,
    volumeRatio: quote.volumeRatio,
    isSt: /^(?:S?\*?ST)/i.test(instrument.name.trim()),
    isLimitUp: quote.limitUp != null
      && quote.close >= quote.limitUp - 0.005,
  }));
  if (historyRows.length > 0) {
    const historyPolicy = getHistoryStorePolicy();
    await Promise.all([
      upsertHistoryDailyBars(historyRows),
      upsertDailyStockMetrics(metricRows),
      historyPolicy.dualWrite ? upsertDailyCandles(normalized) : Promise.resolve(),
    ]);
  }

  const corporateActionCandidates = quoteUpdates.filter(({ instrument, quote }) => {
    const prior = previousBarByKey.get(instrument.instrumentKey);
    return (
      prior
      && quote.previousClose != null
      && hasCorporateActionSignal(prior.close, quote.previousClose)
    );
  });
  const deferredInstrumentIds = new Set([
    ...gapUpdates.map((gap) => gap.instrument.id),
    ...corporateActionCandidates.map(({ instrument }) => instrument.id),
  ]);
  const earlyCompletedItemIds = targets
    .filter((instrument) => (
      !failures.has(instrument.id)
      && !deferredInstrumentIds.has(instrument.id)
    ))
    .map((instrument) => itemIdByInstrumentId.get(instrument.id)!);
  await updateSyncJobItemsStatus(earlyCompletedItemIds, 'completed');
  for (const [instrumentId, error] of failures) {
    await updateSyncJobItem(itemIdByInstrumentId.get(instrumentId)!, {
      status: 'failed',
      errorCode: 'data_error',
      errorMessage: error,
    });
  }
  await updateSyncJobCounts(
    job.id,
    targets.length,
    earlyCompletedItemIds.length,
    failures.size,
  );

  const gapFailures = await mapWithConcurrency(gapUpdates, 6, async (gap) => {
    try {
      await processSymbolCandles(
        gap.instrument.symbol,
        gap.startDate,
        gap.endDate,
        job,
        provider,
        gap.instrument.id,
        gap.instrument,
        true,
      );
      return null;
    } catch (error) {
      return {
        instrument: gap.instrument,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  for (const failure of gapFailures) {
    if (failure) failures.set(failure.instrument.id, failure.message);
  }

  await mapWithConcurrency(corporateActionCandidates, 3, async ({ instrument, quote }) => {
    const prior = previousBarByKey.get(instrument.instrumentKey)!;
    try {
      await refreshAdjustmentAfterCorporateAction({
        instrumentId: instrument.id,
        instrumentKey: instrument.instrumentKey,
        symbol: instrument.symbol,
        tradeDate: quote.date,
        storedPreviousClose: prior.close,
        officialPreviousClose: quote.previousClose!,
        provider,
      });
    } catch (error) {
      await createQualityIssue({
        id: crypto.randomUUID(),
        instrumentId: instrument.id,
        tradeDate: quote.date,
        ruleCode: 'ADJUSTMENT_REFRESH_FAILED',
        severity: 'warning',
        status: 'open',
        details: {
          message: error instanceof Error ? error.message : String(error),
        },
        detectedAt: new Date().toISOString(),
      });
    }
  });

  if (await isJobCancelled(job.id)) {
    await skipRemainingItems(job.id);
    return;
  }

  const completedItemIds: string[] = [];
  for (const instrument of targets) {
    const itemId = itemIdByInstrumentId.get(instrument.id)!;
    const error = failures.get(instrument.id);
    if (error) {
      await updateSyncJobItem(itemId, {
        status: 'failed',
        errorCode: 'data_error',
        errorMessage: error,
      });
      onError({ symbol: instrument.symbol, error });
    } else {
      completedItemIds.push(itemId);
      onSuccess();
    }
    onProcessed();
  }
  await updateSyncJobItemsStatus(completedItemIds, 'completed');
  await updateSyncJobCounts(
    job.id,
    targets.length,
    completedItemIds.length,
    failures.size,
  );
}

// ─── Symbol-Level Candle Processing ─────────────────────────────────

/**
 * Fetches, normalizes, validates and upserts candle data for a single
 * symbol. Runs quality checks after upsert and creates quality issues
 * for any validation errors found.
 */
async function processSymbolCandles(
  symbol: string,
  startDate: string,
  endDate: string,
  job: SyncJob,
  provider: MarketDataProvider,
  instrumentIdOverride?: string,
  instrumentOverride?: Instrument,
  finalizeDailyBar = true,
  rawCandlesOverride?: Awaited<ReturnType<MarketDataProvider['fetchDailyCandles']>>,
): Promise<void> {
  // Resolve instrument
  const instrument = instrumentOverride
    ?? await resolveOrCreateInstrument(symbol, job.requestSnapshot.market, provider);
  const instrumentId = instrumentIdOverride ?? instrument.id;

  // Fetch raw candles from provider
  const rawCandles = rawCandlesOverride ?? await fetchWithRetry(
    () => provider.fetchDailyCandles({
      symbols: [symbol],
      startDate,
      endDate,
      adjustment: 'none',
    }),
    `fetchDailyCandles:${symbol}`,
  );

  if (rawCandles.length === 0) {
    return; // Nothing to do
  }

  // Normalize
  const normalized = normalizeCandles(
    rawCandles,
    instrumentId,
    job.providerId,
  );

  // Validate
  const validation = validateCandleSet(normalized);

  // Upsert candles (always upsert even if validation warnings exist)
  const historyPolicy = getHistoryStorePolicy();
  if (historyPolicy.dualWrite) {
    await upsertDailyCandles(normalized);
  }
  if (instrument.instrumentKey != null) {
    const fetchedAt = new Date().toISOString().slice(0, 23).replace('T', ' ');
    const today = getChinaMarketSession().tradeDate;
    await upsertHistoryDailyBars(rawCandles.map((candle) => ({
      instrumentKey: instrument.instrumentKey!,
      tradeDate: candle.date,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      previousClose: candle.previousClose,
      volume: candle.volume,
      amount: candle.turnover,
      turnoverRatePct: candle.turnoverRatePct,
      sourceKey: sourceKeyForProvider(provider.id),
      sourceVersion: `${SOURCE_VERSION}:${provider.id}`,
      fetchedAt,
      isFinal: candle.date < today || finalizeDailyBar,
    })));

    const latestFetched = [...rawCandles].sort((a, b) =>
      a.date.localeCompare(b.date)).at(-1);
    if (
      latestFetched
      && (latestFetched.date < today || finalizeDailyBar)
      && latestFetched.previousClose != null
    ) {
      const lookbackStart = addDays(latestFetched.date, -14);
      const recentBars = await getHistoryDailyBarsInRange(
        instrument.instrumentKey,
        lookbackStart,
        latestFetched.date,
      );
      const priorBar = [...recentBars]
        .filter((bar) => bar.tradeDate < latestFetched.date)
        .at(-1);
      if (hasCorporateActionSignal(priorBar?.close, latestFetched.previousClose)) {
        try {
          await refreshAdjustmentAfterCorporateAction({
            instrumentId,
            instrumentKey: instrument.instrumentKey,
            symbol,
            tradeDate: latestFetched.date,
            storedPreviousClose: priorBar!.close,
            officialPreviousClose: latestFetched.previousClose,
            provider,
          });
        } catch (error) {
          await createQualityIssue({
            id: crypto.randomUUID(),
            instrumentId,
            tradeDate: latestFetched.date,
            ruleCode: 'ADJUSTMENT_REFRESH_FAILED',
            severity: 'warning',
            status: 'open',
            details: {
              message: error instanceof Error ? error.message : String(error),
            },
            detectedAt: new Date().toISOString(),
          });
        }
      }
    }
  } else if (!historyPolicy.dualWrite) {
    throw new Error(`证券 ${symbol} 缺少 instrument_key，无法写入 v2 行情库`);
  }

  // Create quality issues for validation errors
  for (const err of validation.errors) {
    await createQualityIssue({
      id: crypto.randomUUID(),
      instrumentId,
      tradeDate: err.tradeDate,
      ruleCode: err.ruleCode,
      severity: 'blocked',
      status: 'open',
      details: { message: err.message },
      detectedAt: new Date().toISOString(),
    });
  }

  // Create quality issues for validation warnings
  for (const warn of validation.warnings) {
    await createQualityIssue({
      id: crypto.randomUUID(),
      instrumentId,
      tradeDate: warn.tradeDate,
      ruleCode: warn.ruleCode,
      severity: 'warning',
      status: 'open',
      details: { message: warn.message },
      detectedAt: new Date().toISOString(),
    });
  }
}

// ─── Cancellation Handling ──────────────────────────────────────────

/**
 * Checks whether a sync job has been cancelled by re-reading its
 * status from the database.
 */
async function isJobCancelled(jobId: string): Promise<boolean> {
  const job = await getSyncJob(jobId);
  return job?.status === 'cancelled';
}

/**
 * Marks all pending items for a job as 'skipped' after cancellation.
 */
async function skipRemainingItems(jobId: string): Promise<void> {
  const pendingItems = await getPendingItems(jobId);
  for (const item of pendingItems) {
    await updateSyncJobItem(item.id, {
      status: 'skipped',
      errorMessage: 'Job cancelled',
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Resolves the list of symbols to process from the request snapshot.
 * If specific symbols are provided, uses those. Otherwise, queries all
 * instruments for the given market.
 */
async function resolveSymbols(
  market?: string,
  symbols?: string[],
): Promise<string[]> {
  if (symbols && symbols.length > 0) {
    const eligible: string[] = [];
    for (const symbol of symbols) {
      const instrument = await getInstrumentBySymbol(symbol, market);
      if (!instrument || instrument.status !== 'delisted') eligible.push(symbol);
    }
    return eligible;
  }

  if (!market) {
    throw new Error('Either market or symbols must be specified in request snapshot');
  }

  const instruments = await listAllActiveInstruments([market]);
  return instruments.map((instrument) => instrument.symbol);
}

async function resolveIncrementalTargets(
  market?: string,
  markets?: string[],
  symbols?: string[],
): Promise<Instrument[]> {
  if (symbols && symbols.length > 0) {
    const targets: Instrument[] = [];
    for (const symbol of symbols) {
      const instrument = await getInstrumentBySymbol(symbol, market);
      if (instrument?.status === 'active') targets.push(instrument);
    }
    return targets;
  }
  const requestedMarkets = markets?.length
    ? markets
    : market ? [market] : ['SH', 'SZ', 'BJ'];
  return listAllActiveInstruments(requestedMarkets);
}

async function listAllActiveInstruments(markets: string[]): Promise<Instrument[]> {
  const result: Instrument[] = [];
  for (const market of markets) {
    let offset = 0;
    while (true) {
      const page = await listInstruments({
        market,
        type: 'stock',
        status: 'active',
        offset,
        limit: 500,
      });
      result.push(...page.data);
      offset += page.data.length;
      if (page.data.length === 0 || offset >= page.total) break;
    }
  }
  return result;
}

async function resolveOrCreateInstrument(
  symbol: string,
  market: string | undefined,
  provider: MarketDataProvider,
): Promise<Instrument> {
  const existing = await getInstrumentBySymbol(symbol, market);
  if (existing) {
    if (existing.status === 'delisted') {
      throw new Error(`证券已退市，跳过更新：${symbol}`);
    }
    return existing;
  }
  {
    const page = await provider.fetchInstruments({ symbol, market, pageSize: 1 });
    const item = page.items[0];
    if (!item) throw new Error(`无法从 ${provider.name} 识别证券代码：${symbol}`);

    const now = new Date().toISOString();
    await upsertInstrument({
      id: crypto.randomUUID(),
      market: item.market as never,
      symbol: item.symbol,
      name: item.name,
      type: item.type as never,
      listDate: item.listDate,
      delistDate: item.delistDate,
      status: item.delistDate ? 'delisted' : 'active',
      createdAt: now,
      updatedAt: now,
    });

    const created = await getInstrumentBySymbol(item.symbol, item.market);
    if (!created) throw new Error(`证券写入后仍无法读取：${symbol}`);
    return created;
  }
}

/**
 * Fetches data with retry logic. Uses the retry policy to determine
 * whether and how long to wait between attempts.
 */
async function fetchWithRetry<T>(
  fetchFn: () => Promise<T>,
  operationName: string,
  maxAttempts = 3,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fetchFn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (err instanceof ProviderError) {
        if (!shouldRetry(err, attempt + 1, maxAttempts)) {
          throw err;
        }
        const decision = classifyError(err);
        const delay = calculateBackoff(attempt, decision.baseDelayMs);
        console.warn(
          `[syncExecutor] ${operationName} attempt ${attempt + 1}/${maxAttempts} failed: ${err.message}. Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      } else {
        // Non-provider errors: retry once, then throw
        if (attempt >= 1) throw err;
        console.warn(
          `[syncExecutor] ${operationName} unexpected error: ${lastError.message}. Retrying...`,
        );
        await sleep(1000);
      }
    }
  }

  throw lastError ?? new Error(`${operationName} failed after ${maxAttempts} attempts`);
}

async function fetchCurrentQuotesInChunks(
  provider: MarketDataProvider,
  instruments: Array<Instrument & { instrumentKey: number }>,
  today: string,
): Promise<{
  quotes: ProviderCandle[];
  failures: Array<{
    instrument: Instrument & { instrumentKey: number };
    message: string;
  }>;
}> {
  if (!provider.fetchCurrentDailyCandles) {
    return {
      quotes: [],
      failures: instruments.map((instrument) => ({
        instrument,
        message: `${provider.name} 不支持批量当日行情`,
      })),
    };
  }
  const chunks = Array.from(
    { length: Math.ceil(instruments.length / 25) },
    (_, index) => instruments.slice(index * 25, (index + 1) * 25),
  );
  const results = await mapWithConcurrency(chunks, 6, async (chunk) => {
    try {
      const quotes = await fetchWithRetry(
        () => provider.fetchCurrentDailyCandles!({
          instruments: chunk.map((instrument) => ({
            symbol: instrument.symbol,
            market: instrument.market,
          })),
        }),
        `fetchCurrentDailyCandles:${chunk[0]?.symbol ?? 'empty'}`,
      );
      return {
        quotes: quotes.filter((quote) => quote.date === today),
        failures: [] as Array<{
          instrument: Instrument & { instrumentKey: number };
          message: string;
        }>,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        quotes: [] as ProviderCandle[],
        failures: chunk.map((instrument) => ({ instrument, message })),
      };
    }
  });
  return {
    quotes: results.flatMap((result) => result.quotes),
    failures: results.flatMap((result) => result.failures),
  };
}

async function getPriorOpenDateByMarket(
  markets: Instrument['market'][],
  today: string,
): Promise<Map<Instrument['market'], string>> {
  const result = new Map<Instrument['market'], string>();
  await Promise.all(markets.map(async (market) => {
    const days = await getOpenTradingDays(
      market,
      addDays(today, -20),
      addDays(today, -1),
    );
    result.set(market, days.at(-1) ?? previousWeekday(today));
  }));
  return result;
}

function previousWeekday(today: string): string {
  let value = addDays(today, -1);
  while ([0, 6].includes(new Date(`${value}T00:00:00Z`).getUTCDay())) {
    value = addDays(value, -1);
  }
  return value;
}

function deriveShares(
  marketCap: number | undefined,
  close: number,
): number | null {
  if (marketCap == null || !Number.isFinite(marketCap) || close <= 0) return null;
  return Math.round(marketCap / close);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        result[index] = await worker(values[index], index);
      }
    }),
  );
  return result;
}

/**
 * Updates the job's completedItems and failedItems counts based on
 * the current state of its items in the database.
 */
/**
 * Updates the job's completedItems and failedItems counts based on
 * the current state of its items in the database. Progress is tracked
 * through the items table; the job-level counters serve as a summary
 * visible to callers reading the job record directly.
 */
async function updateSyncJobProgress(jobId: string): Promise<void> {
  const items = await getSyncJobItems(jobId);
  const job = await getSyncJob(jobId);
  if (!job) return;

  const completed = items.filter((i) => i.status === 'completed').length;
  const failed = items.filter((i) => i.status === 'failed').length;

  if (job.completedItems !== completed || job.failedItems !== failed) {
    await updateSyncJobCounts(jobId, job.totalItems, completed, failed);
  }
}

function incrementDate(dateStr: string): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Missing import helper — getInstrument by symbol with market filter
async function getInstrumentBySymbol(
  symbol: string,
  market?: string,
): Promise<Instrument | null> {
  const { data: instruments } = await listInstruments({
    symbol,
    market: market as never | undefined,
  });
  if (instruments.length === 0) return null;
  const active = instruments.find((i) => i.status === 'active');
  return active ?? instruments[0];
}

// ─── Cancellation ───────────────────────────────────────────────────

/**
 * Cancels a running sync job by updating its status and skipping all
 * pending items. The running executor will detect the status change
 * on its next check and stop processing.
 */
export async function cancelSyncJob(jobId: string): Promise<void> {
  const job = await getSyncJob(jobId);
  if (!job) {
    throw new Error(`Sync job not found: ${jobId}`);
  }

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return; // Already terminal
  }

  await updateSyncJobStatus(jobId, 'cancelled', undefined, new Date().toISOString());
  await skipRemainingItems(jobId);
}
