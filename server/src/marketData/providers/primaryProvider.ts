/**
 * Primary (mock) market data provider.
 *
 * A deterministic mock implementation of `MarketDataProvider` used for
 * development and testing.  Generates realistic-enough OHLCV data via
 * a seeded random walk so that charts and backtests function correctly
 * without requiring a live data source.
 *
 * Data characteristics:
 *   - Seeded by symbol + trade date → deterministic across calls
 *   - Daily returns ~ N(0.0005, 0.02) with intraday range
 *   - Volume log-normally distributed
 *   - Trading calendar: Mon–Fri open, weekends + Jan 1–3 closed
 *   - Adjustment factors: factor = 1.0 most days, annual ~3-5 % drop
 */

import type {
  MarketDataProvider,
  ProviderCapabilities,
  InstrumentRequest,
  InstrumentPage,
  CalendarRequest,
  TradingDay,
  DailyCandleRequest,
  ProviderCandle,
  AdjustmentRequest,
  AdjustmentFactor,
} from './provider.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════
// Seeded PRNG — simple linear congruential generator
// ═══════════════════════════════════════════════════════════════════════

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/** Box-Muller transform → N(0, 1) */
function standardNormal(random: () => number): number {
  const u1 = Math.max(random(), 1e-10); // guard log(0)
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ═══════════════════════════════════════════════════════════════════════
// Mock instruments
// ═══════════════════════════════════════════════════════════════════════

interface MockInstrument {
  symbol: string;
  name: string;
  market: string;
  type: string;
  listDate: string;
}

function loadMockInstruments(): MockInstrument[] {
  try {
    const dataPath = resolve(__dirname, '..', 'data', 'instruments.json');
    const raw = readFileSync(dataPath, 'utf-8');
    return JSON.parse(raw) as MockInstrument[];
  } catch {
    return [];
  }
}

const MOCK_INSTRUMENTS: MockInstrument[] = loadMockInstruments();

// Base prices for the 5 instruments explicitly required by the spec.
// Other instruments derive a base price from their symbol hash.
const BASE_PRICES: Record<string, number> = {
  '600519': 1800,
  '000001': 12,
  '600036': 38,
  '300750': 200,
  '000858': 150,
};

function getBasePrice(symbol: string): number {
  if (symbol in BASE_PRICES) return BASE_PRICES[symbol];
  // Deterministic fallback: hash the symbol to a price in [5, 300]
  const h = hashString(symbol);
  return 5 + (h % 295);
}

// ═══════════════════════════════════════════════════════════════════════
// Primary provider implementation
// ═══════════════════════════════════════════════════════════════════════

export const primaryProvider: MarketDataProvider = {
  id: 'mock',
  name: '内置模拟数据',
  type: 'mock',

  // ── Capabilities ────────────────────────────────────────────────

  getCapabilities(): ProviderCapabilities {
    return {
      supportedMarkets: ['SH', 'SZ'],
      supportedDataTypes: [
        'instruments',
        'calendar',
        'daily_candles',
        'adjustment_factors',
      ],
      maxDateRangeDays: 3650,
      rateLimit: {
        requestsPerMinute: 60,
        requestsPerDay: 10000,
      },
    };
  },

  // ── Instruments ─────────────────────────────────────────────────

  async fetchInstruments(request: InstrumentRequest): Promise<InstrumentPage> {
    const pageSize = request.pageSize ?? 10;

    // Filter
    let filtered = MOCK_INSTRUMENTS.filter((inst) => {
      if (request.market && inst.market !== request.market) return false;
      if (request.symbol && inst.symbol !== request.symbol) return false;
      if (request.types && request.types.length > 0) {
        if (!request.types.includes(inst.type)) return false;
      }
      return true;
    });

    // Sort by symbol for deterministic ordering
    filtered = filtered.sort((a, b) => a.symbol.localeCompare(b.symbol));

    // Paginate via cursor (cursor = symbol of last returned item)
    let startIndex = 0;
    if (request.cursor) {
      const cursorIdx = filtered.findIndex(
        (inst) => inst.symbol === request.cursor,
      );
      if (cursorIdx >= 0) {
        startIndex = cursorIdx + 1;
      }
    }

    const page = filtered.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + pageSize < filtered.length;
    const cursor = page.length > 0 ? page[page.length - 1].symbol : undefined;

    return {
      items: page.map((inst) => ({ ...inst })),
      cursor: hasMore ? cursor : undefined,
      hasMore,
    };
  },

  // ── Trading Calendar ────────────────────────────────────────────

  async fetchTradingCalendar(
    request: CalendarRequest,
  ): Promise<TradingDay[]> {
    const result: TradingDay[] = [];
    const start = new Date(request.startDate + 'T00:00:00');
    const end = new Date(request.endDate + 'T00:00:00');

    for (
      let d = new Date(start);
      d <= end;
      d.setDate(d.getDate() + 1)
    ) {
      const dateStr = toISODate(d);
      const dayOfWeek = d.getDay(); // 0 = Sunday, 6 = Saturday
      const month = d.getMonth() + 1; // 1-based
      const day = d.getDate();

      // Weekends are always closed
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        result.push({ date: dateStr, isOpen: false });
        continue;
      }

      // Jan 1–3 are holidays (New Year)
      if (month === 1 && day >= 1 && day <= 3) {
        result.push({ date: dateStr, isOpen: false });
        continue;
      }

      result.push({ date: dateStr, isOpen: true });
    }

    return result;
  },

  // ── Daily Candles ───────────────────────────────────────────────

  async fetchDailyCandles(
    request: DailyCandleRequest,
  ): Promise<ProviderCandle[]> {
    const result: ProviderCandle[] = [];
    const start = new Date(request.startDate + 'T00:00:00');
    const end = new Date(request.endDate + 'T00:00:00');

    for (const symbol of request.symbols) {
      let prevClose = getBasePrice(symbol);

      for (
        let d = new Date(start);
        d <= end;
        d.setDate(d.getDate() + 1)
      ) {
        // Skip non-trading days (weekends + Jan 1-3)
        if (!isTradingDay(d)) continue;

        const dateStr = toISODate(d);
        const candle = generateCandle(symbol, dateStr, prevClose);
        prevClose = candle.close;
        result.push(candle);
      }
    }

    return result;
  },

  // ── Adjustment Factors ──────────────────────────────────────────

  async fetchAdjustmentFactors(
    request: AdjustmentRequest,
  ): Promise<AdjustmentFactor[]> {
    const result: AdjustmentFactor[] = [];
    const start = new Date(request.startDate + 'T00:00:00');
    const end = new Date(request.endDate + 'T00:00:00');

    for (const symbol of request.symbols) {
      let cumulativeFactor = 1.0;

      for (
        let d = new Date(start);
        d <= end;
        d.setDate(d.getDate() + 1)
      ) {
        if (!isTradingDay(d)) continue;

        const dateStr = toISODate(d);
        const month = d.getMonth() + 1;
        const day = d.getDate();

        // Simulate an annual dividend around mid-June.  On the designated
        // ex-dividend date the cumulative factor drops by 3–5 %.
        if (month === 6 && day === 15) {
          const seed = hashString(`${symbol}-div-${d.getFullYear()}`);
          const rng = createSeededRandom(seed);
          const drop = 0.03 + rng() * 0.02; // 3–5 %
          cumulativeFactor = round4(cumulativeFactor * (1 - drop));
        }

        result.push({
          symbol,
          date: dateStr,
          factor: cumulativeFactor,
        });
      }
    }

    return result;
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Generate a single realistic OHLCV candle using a seeded random walk.
 *
 * The seed is derived from `symbol + date` so the same inputs always
 * produce the same candle.
 */
function generateCandle(
  symbol: string,
  dateStr: string,
  prevClose: number,
): ProviderCandle {
  const seed = hashString(`${symbol}:${dateStr}`);
  const rng = createSeededRandom(seed);

  // Daily log-return ~ N(0.0005, 0.02)
  const logReturn = 0.0005 + 0.02 * standardNormal(rng);
  const close = Math.max(prevClose * Math.exp(logReturn), 0.01);

  // Open: somewhere between prevClose and close
  const openWeight = 0.3 + rng() * 0.4; // 0.3–0.7
  const open = prevClose + (close - prevClose) * openWeight;

  // High above max(open, close), Low below min(open, close)
  const intraRange = 0.005 + rng() * 0.02; // 0.5%–2.5% intraday range
  const high = Math.max(open, close) * (1 + intraRange * rng());
  const low = Math.min(open, close) * (1 - intraRange * rng());

  // Volume: log-normally distributed, inversely scaled by price
  const baseVolume = 5_000_000;
  const logVol = Math.log(baseVolume) + 0.5 * standardNormal(rng);
  const volume = Math.max(Math.round(Math.exp(logVol)), 100);

  // Turnover (成交额): approximately volume * average price
  const avgPrice = (open + high + low + close) / 4;
  const turnover = round4(volume * avgPrice);

  return {
    symbol,
    date: dateStr,
    open: round4(open),
    high: round4(high),
    low: round4(low),
    close: round4(close),
    volume,
    turnover,
  };
}

/** Determine whether a date is a trading day (Mon–Fri, excluding Jan 1–3). */
function isTradingDay(date: Date): boolean {
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (month === 1 && day >= 1 && day <= 3) return false;
  return true;
}

/** Convert a Date to YYYY-MM-DD without timezone offset. */
function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Round to 4 decimal places. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
