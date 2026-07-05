// ─── Sync Executor ─────────────────────────────────────────────────
// Core sync execution engine. Orchestrates the full sync flow for all
// job types: instruments, calendar, history, and incremental.

import type { Instrument, SyncJob, TradingCalendarEntry } from '../types.js';
import type { MarketDataProvider } from '../providers/provider.js';
import { ProviderError } from '../providers/provider.js';
import { classifyError, calculateBackoff, shouldRetry } from './retryPolicy.js';
import { validateCandleSet } from '../quality/validators.js';
import { normalizeCandles } from '../normalization/candleNormalizer.js';
import { listProviders } from '../providers/providerRegistry.js';

import { listInstruments, upsertInstrument } from '../repositories/instrumentRepository.js';
import { upsertCalendarEntries } from '../repositories/calendarRepository.js';
import {
  getHistoryDailyBarsInRange,
  getLatestHistoryDailyBar,
  upsertDailyCandles,
  upsertHistoryDailyBars,
} from '../repositories/marketDataRepository.js';
import {
  getSyncJob,
  updateSyncJobStatus,
  updateSyncJobCounts,
  updateSyncJobItem,
  createSyncJobItems,
  getSyncJobItems,
  getPendingItems,
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
  let currentQuotes: Awaited<ReturnType<NonNullable<MarketDataProvider['fetchCurrentDailyCandles']>>>
    | null = null;
  if (provider.fetchCurrentDailyCandles) {
    try {
      currentQuotes = await fetchWithRetry(
        () => provider.fetchCurrentDailyCandles!({
          instruments: targets.map((instrument) => ({
            symbol: instrument.symbol,
            market: instrument.market,
          })),
        }),
        'fetchCurrentDailyCandles',
      );
    } catch (error) {
      console.warn(
        `[syncExecutor] 批量当日行情不可用，回退逐证券 K 线：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const currentQuoteByInstrument = new Map(
    (currentQuotes ?? []).map((candle) => [`${candle.symbol}:${candle.date}`, candle]),
  );

  for (let i = 0; i < targets.length; i++) {
    if (await isJobCancelled(job.id)) {
      await skipRemainingItems(job.id);
      return;
    }

    const instrument = targets[i];
    const symbol = instrument.symbol;
    try {
      if (instrument.status === 'delisted') {
        onSuccess();
        onProcessed();
        continue;
      }
      if (instrument.instrumentKey == null) {
        throw new Error(`Instrument key missing: ${symbol}`);
      }

      const latestBar = await getLatestHistoryDailyBar(instrument.instrumentKey);
      let fetchStartDate: string;

      if (!latestBar) {
        // No data yet — use instrument listDate or a safe default
        fetchStartDate = instrument.listDate ?? '2010-01-01';
      } else {
        // A provisional current-day row is intentionally fetched again.
        fetchStartDate = latestBar.isFinal === 0
          ? latestBar.tradeDate
          : incrementDate(latestBar.tradeDate);
      }

      if (fetchStartDate > today) {
        // Already up to date
        onSuccess();
        onProcessed();
        continue;
      }

      await processSymbolCandles(
        symbol,
        fetchStartDate,
        today,
        job,
        provider,
        instrument.id,
        instrument,
        finalizeDailyBar,
        fetchStartDate === today && currentQuotes !== null
          ? [currentQuoteByInstrument.get(`${symbol}:${today}`)].filter(
              (candle): candle is NonNullable<typeof candle> => candle != null,
            )
          : undefined,
      );
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError({ symbol, error: message });
    }
    onProcessed();

    if ((i + 1) % CHUNK_SIZE === 0 || i === targets.length - 1) {
      await updateSyncJobProgress(job.id);
    }
  }
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
  await upsertDailyCandles(normalized);
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
