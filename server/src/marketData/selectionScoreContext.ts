import type { StockQuote } from './aStockDataService.js';

export interface SelectionScoreContextRecord {
  source?: unknown;
  date?: unknown;
  metrics?: unknown;
}

export interface SelectionScoreContext {
  peTtm: number | null;
  pb: number | null;
  psTtm: number | null;
  marketCapYi: number | null;
  floatMarketCapYi: number | null;
  dividendYieldPct: number | null;
  roePct: number | null;
  revenueGrowthPct: number | null;
  netProfitGrowthPct: number | null;
  debtRatioPct: number | null;
  asOf: string | null;
  sources: string[];
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[%亿,]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function recordsOf(layer: Record<string, unknown>): SelectionScoreContextRecord[] {
  return Array.isArray(layer.records)
    ? layer.records.filter((record): record is SelectionScoreContextRecord => Boolean(record && typeof record === 'object'))
    : [];
}

function metric(records: SelectionScoreContextRecord[], ...keys: string[]): number | null {
  for (const record of records) {
    if (!record.metrics || typeof record.metrics !== 'object') continue;
    const values = record.metrics as Record<string, unknown>;
    for (const key of keys) {
      const value = finiteNumber(values[key]);
      if (value != null) return value;
    }
  }
  return null;
}

function latestDate(records: SelectionScoreContextRecord[]): string | null {
  return records
    .map((record) => typeof record.date === 'string' ? record.date.slice(0, 10) : '')
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

export function extractSelectionScoreContext(
  quote: StockQuote,
  fundamentalLayer: Record<string, unknown>,
  dividendLayer: Record<string, unknown>,
): SelectionScoreContext {
  const fundamentals = recordsOf(fundamentalLayer);
  const dividends = recordsOf(dividendLayer);
  const records = [...fundamentals, ...dividends];
  const sources = [...new Set([
    ...quote.source,
    ...records.flatMap((record) => (
      typeof record.source === 'string' && record.source ? [record.source] : []
    )),
  ])];

  return {
    peTtm: quote.peTtm ?? metric(fundamentals, 'peTtm'),
    pb: quote.pb ?? metric(fundamentals, 'pb'),
    psTtm: metric(fundamentals, 'psTtm', 'ps'),
    marketCapYi: quote.marketCapYi ?? (
      metric(fundamentals, 'totalMarketCap') != null
        ? metric(fundamentals, 'totalMarketCap')! / 100_000_000
        : null
    ),
    floatMarketCapYi: quote.floatMarketCapYi ?? (
      metric(fundamentals, 'floatMarketCap') != null
        ? metric(fundamentals, 'floatMarketCap')! / 100_000_000
        : null
    ),
    dividendYieldPct: metric(dividends, 'dividendYield')
      ?? metric(fundamentals, 'dividendYield'),
    roePct: metric(fundamentals, 'roe'),
    revenueGrowthPct: metric(fundamentals, 'revenueGrowth'),
    netProfitGrowthPct: metric(fundamentals, 'netProfitGrowth'),
    debtRatioPct: metric(fundamentals, 'debtRatio'),
    asOf: latestDate(records),
    sources,
  };
}
