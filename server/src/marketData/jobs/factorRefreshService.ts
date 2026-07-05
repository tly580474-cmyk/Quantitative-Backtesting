import { createHash } from 'node:crypto';
import type { MarketDataProvider } from '../providers/provider.js';
import {
  getHistoryDailyBarsInRange,
  getPublishedFactorState,
  publishHistoryAdjustment,
} from '../repositories/marketDataRepository.js';
import {
  buildAdjustmentRefreshPlan,
  type AdjustmentRefreshPlan,
} from './adjustmentRefresh.js';

const LOOKBACK_CALENDAR_DAYS = 75;

export async function refreshAdjustmentAfterCorporateAction(input: {
  instrumentId: string;
  instrumentKey: number;
  symbol: string;
  tradeDate: string;
  storedPreviousClose: number;
  officialPreviousClose: number;
  provider: MarketDataProvider;
}): Promise<AdjustmentRefreshPlan> {
  const published = await getPublishedFactorState(input.instrumentKey);
  if (!published || published.factors.length === 0) {
    return {
      changed: false,
      factors: [],
      eventDate: null,
      priorTransform: { factor: 1, offset: 0 },
      validation: emptyValidation(),
      reason: 'missing_baseline',
    };
  }

  const startDate = addDays(input.tradeDate, -LOOKBACK_CALENDAR_DAYS);
  const [rawBars, qfqBars] = await Promise.all([
    getHistoryDailyBarsInRange(input.instrumentKey, startDate, input.tradeDate),
    fetchQfqWithRetry(input.provider, input.symbol, startDate, input.tradeDate),
  ]);
  const rawRows = rawBars.map((bar) => ({
    tradeDate: bar.tradeDate,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
  const qfqRows = qfqBars.map((bar) => ({
    tradeDate: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
  const plan = buildAdjustmentRefreshPlan(
    published.factors,
    rawRows,
    qfqRows,
  );
  if (!plan.changed || !plan.eventDate) return plan;

  const sourceFingerprint = createHash('sha256')
    .update(JSON.stringify({
      provider: input.provider.id,
      instrumentKey: input.instrumentKey,
      tradeDate: input.tradeDate,
      factors: plan.factors,
    }))
    .digest('hex');
  const factorVersion = `live-${sourceFingerprint.slice(0, 20)}`;
  const sourceBatchId = crypto.randomUUID();

  await publishHistoryAdjustment({
    instrumentKey: input.instrumentKey,
    factorVersion,
    sourceBatchId,
    sourceRoot: `provider:${input.provider.id}`,
    sourceFingerprint,
    sourceKey: sourceKeyForProvider(input.provider.id),
    checkedDate: input.tradeDate,
    factors: plan.factors,
    event: {
      id: crypto.randomUUID(),
      exDate: plan.eventDate,
      previousClose: input.storedPreviousClose,
      exReferencePrice: input.officialPreviousClose,
    },
    priorTransform: plan.priorTransform,
  });
  return plan;
}

async function fetchQfqWithRetry(
  provider: MarketDataProvider,
  symbol: string,
  startDate: string,
  endDate: string,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await provider.fetchDailyCandles({
        symbols: [symbol],
        startDate,
        endDate,
        adjustment: 'qfq',
      });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}

export function sourceKeyForProvider(providerId: string): number {
  if (providerId === 'tencent') return 2;
  if (providerId === 'akshare') return 3;
  if (providerId === 'mock') return 99;
  let hash = 0;
  for (const char of providerId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 100 + (hash % 10_000);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function emptyValidation() {
  return {
    comparedPrices: 0,
    withinTickPrices: 0,
    withinTickRatio: 0,
    meanAbsoluteError: 0,
    maxAbsoluteError: 0,
    firstMismatchDate: null,
  };
}
