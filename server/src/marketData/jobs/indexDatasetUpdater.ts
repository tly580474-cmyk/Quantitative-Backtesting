import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { TencentMarketDataProvider } from '../providers/tencentProvider.js';

const { marketDatasets, candles, syncJobs } = schema;

const CN_INDEX_SYMBOLS = new Set([
  '000001', // 上证指数
  '399001', // 深证成指
  '399006', // 创业板指
  '000300', // 沪深300
  '000905', // 中证500
  '000852', // 中证1000
  '932000', // 中证2000
  '000688', // 科创50
  '000680', // 科创综指
]);

const EASTMONEY_INDEX_SECIDS: Record<string, string> = {
  '000001': '1.000001',
  '000300': '1.000300',
  '000905': '1.000905',
  '000852': '1.000852',
  '932000': '2.932000',
  '000688': '1.000688',
  '000680': '1.000680',
};

type DatasetRow = typeof marketDatasets.$inferSelect;
type CandleInsert = typeof candles.$inferInsert;
type IndexGroup = 'cn-index' | 'us-index';

export interface IndexDatasetUpdateResult {
  group: IndexGroup;
  targetDate: string;
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  details: Array<{
    datasetId: string;
    symbol: string;
    status: 'updated' | 'skipped' | 'failed';
    fromDate?: string;
    toDate?: string;
    inserted?: number;
    reason?: string;
  }>;
}

export async function updateIndexDatasets(
  group: IndexGroup,
  provider: TencentMarketDataProvider,
  now = new Date(),
  options: { force?: boolean } = {},
): Promise<IndexDatasetUpdateResult> {
  const targetDate = resolveIndexTargetDate(group, now);
  const runKey = `${group}:${targetDate}`;

  if (!options.force && await hasTerminalRun(runKey)) {
    return { group, targetDate, scanned: 0, updated: 0, skipped: 0, failed: 0, details: [] };
  }

  const jobId = crypto.randomUUID();
  await createRun(jobId, group, runKey, targetDate);

  const datasets = (await getDb()
    .select()
    .from(marketDatasets)
    .orderBy(desc(marketDatasets.updatedAt)))
    .filter((dataset) => group === 'cn-index' ? isChinaIndexDataset(dataset) : isNasdaq100Dataset(dataset));

  const details: IndexDatasetUpdateResult['details'] = [];

  for (const dataset of datasets) {
    const fromDate = options.force ? targetDate : addDays(dataset.endTime, 1);
    if (fromDate > targetDate) {
      details.push({
        datasetId: dataset.id,
        symbol: dataset.symbol,
        status: 'skipped',
        reason: `已更新到 ${dataset.endTime}`,
      });
      continue;
    }

    try {
      const nextCandles = group === 'cn-index'
        ? await fetchChinaIndexCandles(provider, dataset.symbol, fromDate, targetDate)
        : await fetchNasdaq100Candles(fromDate, targetDate);

      const fresh = nextCandles
        .filter((item) => (
          item.time <= targetDate
          && (options.force ? item.time >= fromDate : item.time > dataset.endTime)
        ))
        .sort((a, b) => a.time.localeCompare(b.time));

      if (fresh.length === 0) {
        details.push({
          datasetId: dataset.id,
          symbol: dataset.symbol,
          status: 'skipped',
          fromDate,
          toDate: targetDate,
          reason: '上游暂无新交易日数据',
        });
        continue;
      }

      await appendDatasetCandles(dataset, fresh);
      details.push({
        datasetId: dataset.id,
        symbol: dataset.symbol,
        status: 'updated',
        fromDate,
        toDate: fresh[fresh.length - 1].time,
        inserted: fresh.length,
      });
    } catch (error) {
      details.push({
        datasetId: dataset.id,
        symbol: dataset.symbol,
        status: 'failed',
        fromDate,
        toDate: targetDate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const updated = details.filter((item) => item.status === 'updated').length;
  const failed = details.filter((item) => item.status === 'failed').length;
  const skipped = details.filter((item) => item.status === 'skipped').length;

  await finishRun(jobId, datasets.length, updated + skipped, failed, failed > 0 ? 'failed' : 'completed');

  return {
    group,
    targetDate,
    scanned: datasets.length,
    updated,
    skipped,
    failed,
    details,
  };
}

function isChinaIndexDataset(dataset: DatasetRow): boolean {
  return dataset.assetType === 'index' && CN_INDEX_SYMBOLS.has(dataset.symbol);
}

function isNasdaq100Dataset(dataset: DatasetRow): boolean {
  return dataset.assetType === 'index'
    && (dataset.symbol.toUpperCase() === 'NDX' || dataset.name.includes('纳斯达克100'));
}

async function fetchChinaIndexCandles(
  provider: TencentMarketDataProvider,
  symbol: string,
  startDate: string,
  endDate: string,
) {
  try {
    const providerRows = await provider.fetchDailyCandles({
      symbols: [symbol],
      startDate,
      endDate,
      adjustment: 'none',
    });
    const rows = providerRows.map((item) => ({
      time: item.date,
      symbol,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
      turnoverRatePct: item.turnoverRatePct,
    }));
    if (rows.length > 0) return rows;
  } catch {
    // Tencent is preferred for non-blocking A-share data, but several CSI
    // indices are intermittently unavailable there or need non-obvious market
    // prefixes. Fall through to Eastmoney for the small existing-dataset set.
  }
  return fetchEastmoneyIndexCandles(symbol, startDate, endDate);
}

async function fetchEastmoneyIndexCandles(symbol: string, startDate: string, endDate: string) {
  const secid = EASTMONEY_INDEX_SECIDS[symbol];
  if (!secid) return [];
  const params = new URLSearchParams({
    secid,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: '101',
    fqt: '0',
    beg: startDate.replaceAll('-', ''),
    end: endDate.replaceAll('-', ''),
  });
  const payload = await fetchJsonWithRetry<{ data?: { klines?: string[] } }>(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      Referer: 'https://quote.eastmoney.com/',
      Accept: 'application/json',
    },
  }, '东方财富指数接口');
  return (payload.data?.klines ?? []).flatMap((row) => {
    const [time, open, close, high, low, volume, turnover, _amplitude, changePercent, change] = row.split(',');
    const values = [open, close, high, low].map(Number);
    if (!time || values.some((value) => !Number.isFinite(value))) return [];
    return [{
      time,
      symbol,
      open: values[0],
      high: values[2],
      low: values[3],
      close: values[1],
      change: Number(change),
      changePercent: Number(changePercent),
      volume: Number(volume) || 0,
      turnover: Number(turnover) || undefined,
      turnoverRatePct: undefined,
      constituentCount: undefined,
    }];
  });
}

async function fetchNasdaq100Candles(startDate: string, endDate: string) {
  const period1 = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${addDays(endDate, 1)}T00:00:00Z`) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?period1=${period1}&period2=${period2}&interval=1d`;
  const payload = await fetchJsonWithRetry<{
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[] }> };
      }>;
      error?: { description?: string };
    };
  }>(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      Accept: 'application/json',
    },
  }, 'Nasdaq100 上游接口');
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(payload.chart?.error?.description ?? 'Nasdaq100 上游暂无数据');
  const quote = result.indicators?.quote?.[0];
  const timestamps = result.timestamp ?? [];
  if (!quote || timestamps.length === 0) return [];

  return timestamps.flatMap((timestamp, index) => {
    const open = quote.open?.[index];
    const high = quote.high?.[index];
    const low = quote.low?.[index];
    const close = quote.close?.[index];
    if (![open, high, low, close].every((value) => typeof value === 'number' && Number.isFinite(value))) return [];
    return [{
      time: new Date(timestamp * 1000).toISOString().slice(0, 10),
      symbol: 'NDX',
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: quote.volume?.[index] ?? 0,
    }];
  });
}

async function appendDatasetCandles(
  dataset: DatasetRow,
  rows: Array<Omit<CandleInsert, 'datasetId'>>,
): Promise<void> {
  const db = getDb();
  const storedRows = rows.map((item) => ({
    datasetId: dataset.id,
    time: item.time,
    symbol: dataset.symbol,
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close,
    change: item.change ?? null,
    changePercent: item.changePercent ?? null,
    volume: item.volume ?? null,
    turnover: item.turnover ?? null,
    turnoverRatePct: item.turnoverRatePct ?? null,
    constituentCount: item.constituentCount ?? null,
  }));

  await db.transaction(async (tx) => {
    for (const row of storedRows) {
      await tx.insert(candles).values(row).onDuplicateKeyUpdate({
        set: {
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          turnover: row.turnover,
          turnoverRatePct: row.turnoverRatePct,
          constituentCount: row.constituentCount,
        },
      });
    }
  });

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(candles)
    .where(eq(candles.datasetId, dataset.id));
  const [{ startTime }] = await db
    .select({ startTime: sql<string>`min(${candles.time})` })
    .from(candles)
    .where(eq(candles.datasetId, dataset.id));
  const [{ endTime }] = await db
    .select({ endTime: sql<string>`max(${candles.time})` })
    .from(candles)
    .where(eq(candles.datasetId, dataset.id));
  const checksum = await computeDatasetChecksum(dataset.id);

  await db.update(marketDatasets)
    .set({
      startTime: startTime ?? dataset.startTime,
      endTime: endTime ?? dataset.endTime,
      count: Number(count ?? dataset.count),
      checksum,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(marketDatasets.id, dataset.id));
}

async function computeDatasetChecksum(datasetId: string): Promise<string> {
  const rows = await getDb()
    .select({
      time: candles.time,
      open: candles.open,
      high: candles.high,
      low: candles.low,
      close: candles.close,
      volume: candles.volume,
      turnoverRatePct: candles.turnoverRatePct,
    })
    .from(candles)
    .where(eq(candles.datasetId, datasetId))
    .orderBy(candles.time);

  let hash = 0;
  for (const candle of rows) {
    const base = `${candle.time}|${candle.open}|${candle.high}|${candle.low}|${candle.close}|${candle.volume ?? 0}`;
    const value = candle.turnoverRatePct == null ? base : `${base}|${candle.turnoverRatePct}`;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(index);
      hash |= 0;
    }
  }
  return hash.toString(16);
}

async function createRun(jobId: string, group: IndexGroup, runKey: string, targetDate: string) {
  const now = new Date().toISOString();
  await getDb().insert(syncJobs).values({
    id: jobId,
    jobType: 'dataset-index-incremental',
    status: 'running',
    providerId: group === 'cn-index' ? 'tencent' : 'yahoo',
    requestSnapshot: { group, runKey, targetDate },
    totalItems: 0,
    completedItems: 0,
    failedItems: 0,
    startedAt: now,
    createdAt: now,
  });
}

async function finishRun(
  jobId: string,
  totalItems: number,
  completedItems: number,
  failedItems: number,
  status: 'completed' | 'failed',
) {
  await getDb().update(syncJobs)
    .set({
      status,
      totalItems,
      completedItems,
      failedItems,
      finishedAt: new Date().toISOString(),
    })
    .where(eq(syncJobs.id, jobId));
}

async function hasTerminalRun(runKey: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: syncJobs.id })
    .from(syncJobs)
    .where(and(
      eq(syncJobs.jobType, 'dataset-index-incremental'),
      inArray(syncJobs.status, ['running', 'completed']),
      sql`JSON_UNQUOTE(JSON_EXTRACT(${syncJobs.requestSnapshot}, '$.runKey')) = ${runKey}`,
    ))
    .limit(1);
  return rows.length > 0;
}

function dateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function timeInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  const second = parts.find((part) => part.type === 'second')?.value;
  return `${hour}:${minute}:${second}`;
}

/**
 * Daily candles are only eligible after their market has closed.
 * A manual intraday update therefore stops at the previous business day,
 * preventing an unfinished daily candle from entering a backtest dataset.
 */
export function resolveIndexTargetDate(group: IndexGroup, now = new Date()): string {
  const timeZone = group === 'cn-index' ? 'Asia/Shanghai' : 'America/New_York';
  const closeTime = group === 'cn-index' ? '15:00:00' : '16:00:00';
  const localDate = dateInTimezone(now, timeZone);
  const localTime = timeInTimezone(now, timeZone);
  const localDay = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  const isBusinessDay = localDay !== 0 && localDay !== 6;

  const candidate = isBusinessDay && localTime >= closeTime
    ? localDate
    : addDays(localDate, -1);
  return currentOrPreviousBusinessDate(candidate);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  label: string,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(900 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} 请求失败`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentOrPreviousBusinessDate(value: string): string {
  let cursor = addDays(value, 1);
  do {
    cursor = addDays(cursor, -1);
    const day = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) return cursor;
  } while (true);
}
