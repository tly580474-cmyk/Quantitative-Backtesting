import type {
  AdjustmentFactor,
  AdjustmentRequest,
  CalendarRequest,
  CurrentDailyCandleRequest,
  DailyCandleRequest,
  InstrumentPage,
  InstrumentRequest,
  MarketDataProvider,
  ProviderCandle,
  ProviderCapabilities,
  ProviderInstrument,
  TradingDay,
} from './provider.js';
import { ProviderError } from './provider.js';

const BASE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const MAX_WINDOW_DAYS = 700;
const MIN_REQUEST_INTERVAL_MS = 1800;
const SH_INDEX_SYMBOLS = new Set(['000001', '000300', '000905', '000852', '000688', '000680']);

type Adjustment = NonNullable<DailyCandleRequest['adjustment']>;

interface TencentPayload {
  code?: number;
  msg?: string;
  data?: Record<string, {
    day?: unknown[][];
    qfqday?: unknown[][];
    hfqday?: unknown[][];
    qt?: Record<string, unknown[]>;
  }>;
}

export class TencentMarketDataProvider implements MarketDataProvider {
  readonly id = 'tencent';
  readonly name = '腾讯财经';
  readonly type = 'live' as const;

  private lastRequestAt = 0;
  private requestQueue: Promise<void> = Promise.resolve();

  getCapabilities(): ProviderCapabilities {
    return {
      supportedMarkets: ['SH', 'SZ'],
      supportedDataTypes: ['instruments', 'calendar', 'daily_candles'],
      maxDateRangeDays: MAX_WINDOW_DAYS,
      rateLimit: { requestsPerMinute: 20, requestsPerDay: 10000 },
    };
  }

  async fetchInstruments(request: InstrumentRequest): Promise<InstrumentPage> {
    if (!request.symbol) return { items: [], hasMore: false };

    const code = toTencentCode(request.symbol, request.market);
    const payload = await this.fetchKline(code, 'none', '', '', 1);
    const node = payload.data?.[code];
    const quote = node?.qt?.[code];
    if (!quote) return { items: [], hasMore: false };

    const item: ProviderInstrument = {
      symbol: String(quote[2] ?? stripMarketPrefix(code)),
      name: String(quote[1] ?? request.symbol),
      market: marketFromCode(code),
      type: inferInstrumentType(code),
    };
    return { items: [item], hasMore: false };
  }

  async fetchTradingCalendar(request: CalendarRequest): Promise<TradingDay[]> {
    const benchmark = request.market.toUpperCase() === 'SZ' ? 'sz399001' : 'sh000001';
    const candles = await this.fetchDailyCandles({
      symbols: [benchmark],
      startDate: request.startDate,
      endDate: request.endDate,
      adjustment: 'none',
    });
    const openDates = new Set(candles.map((candle) => candle.date));
    const result: TradingDay[] = [];
    for (let cursor = request.startDate; cursor <= request.endDate; cursor = addDays(cursor, 1)) {
      result.push({ date: cursor, isOpen: openDates.has(cursor) });
    }
    return result;
  }

  async fetchDailyCandles(request: DailyCandleRequest): Promise<ProviderCandle[]> {
    if (request.startDate > request.endDate) {
      throw new ProviderError('开始日期不能晚于结束日期', 'invalid_params', false);
    }

    const adjustment = request.adjustment ?? 'none';
    const result: ProviderCandle[] = [];
    for (const symbol of request.symbols) {
      const code = toTencentCode(symbol);
      for (const range of splitDateRange(request.startDate, request.endDate)) {
        const payload = await this.fetchKline(code, adjustment, range.start, range.end, 640);
        result.push(...parseCandles(payload, code, symbol, adjustment));
      }
    }

    const unique = new Map<string, ProviderCandle>();
    for (const candle of result) unique.set(`${candle.symbol}:${candle.date}`, candle);
    return Array.from(unique.values()).sort((a, b) =>
      a.symbol.localeCompare(b.symbol) || a.date.localeCompare(b.date));
  }

  async fetchAdjustmentFactors(_request: AdjustmentRequest): Promise<AdjustmentFactor[]> {
    // This endpoint returns already-adjusted candles, not standalone factors.
    return [];
  }

  async fetchCurrentDailyCandles(
    request: CurrentDailyCandleRequest,
  ): Promise<ProviderCandle[]> {
    const chunks: Array<Array<{ symbol: string; market: string }>> = [];
    for (let index = 0; index < request.instruments.length; index += 70) {
      chunks.push(request.instruments.slice(index, index + 70));
    }
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(6, chunks.length) },
      async () => {
        const rows: ProviderCandle[] = [];
        while (cursor < chunks.length) {
          const chunk = chunks[cursor++];
          rows.push(...await this.fetchQuoteChunk(chunk));
        }
        return rows;
      },
    );
    return (await Promise.all(workers)).flat();
  }

  private async fetchKline(
    code: string,
    adjustment: Adjustment,
    startDate: string,
    endDate: string,
    count: number,
  ): Promise<TencentPayload> {
    const adjustParam = adjustment === 'none' ? '0' : adjustment;
    const params = new URLSearchParams({
      param: `${code},day,${startDate},${endDate},${count},${adjustParam}`,
      r: Math.random().toString(),
    });

    return this.enqueue(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(`${BASE_URL}?${params.toString()}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            Referer: 'https://stock.qq.com/',
            Accept: '*/*',
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new ProviderError(
            `腾讯行情请求失败：HTTP ${response.status}`,
            response.status === 403 || response.status === 429 ? 'rate_limit' : 'network',
            response.status >= 500 || response.status === 403 || response.status === 429,
          );
        }
        const payload = await response.json() as TencentPayload;
        if (payload.code !== 0 || !payload.data) {
          throw new ProviderError(
            `腾讯行情返回异常：${payload.msg || `code=${payload.code}`}`,
            'data_error',
            false,
            payload,
          );
        }
        return payload;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderError(`腾讯行情网络错误：${message}`, 'network', true, error);
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.requestQueue.then(async () => {
      const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt));
      if (waitMs > 0) await sleep(waitMs);
      try {
        return await task();
      } finally {
        this.lastRequestAt = Date.now();
      }
    });
    this.requestQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fetchQuoteChunk(
    instruments: Array<{ symbol: string; market: string }>,
  ): Promise<ProviderCandle[]> {
    const codes = instruments.map((item) => toTencentQuoteCode(item.symbol, item.market));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`${QUOTE_URL}${codes.join(',')}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://stock.qq.com/',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ProviderError(
          `腾讯批量行情请求失败：HTTP ${response.status}`,
          response.status === 403 || response.status === 429 ? 'rate_limit' : 'network',
          response.status >= 500 || response.status === 403 || response.status === 429,
        );
      }
      const text = new TextDecoder('gbk').decode(await response.arrayBuffer());
      return parseQuoteCandles(text);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `腾讯批量行情网络错误：${error instanceof Error ? error.message : String(error)}`,
        'network',
        true,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const tencentProvider = new TencentMarketDataProvider();

export function parseCandles(
  payload: TencentPayload,
  code: string,
  requestedSymbol: string,
  adjustment: Adjustment,
): ProviderCandle[] {
  const key = adjustment === 'none' ? 'day' : `${adjustment}day` as 'qfqday' | 'hfqday';
  const node = payload.data?.[code];
  const rows = node?.[key] ?? [];
  const quote = node?.qt?.[code];
  const quoteDate = normalizeQuoteDate(quote?.[30]);
  const quotePreviousClose = Number(quote?.[4]);

  return rows.flatMap((row) => {
    // Tencent currently returns: date, open, close, high, low, volume.
    if (row.length < 6) return [];
    const [date, open, close, high, low, volume] = row;
    const values = [open, high, low, close, volume].map(Number);
    if (typeof date !== 'string' || values.some((value) => !Number.isFinite(value))) return [];
    return [{
      symbol: requestedSymbol,
      date,
      open: values[0],
      high: values[1],
      low: values[2],
      close: values[3],
      ...(date === quoteDate && Number.isFinite(quotePreviousClose)
        ? { previousClose: quotePreviousClose }
        : {}),
      volume: values[4],
    }];
  });
}

function normalizeQuoteDate(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 8);
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export function parseQuoteCandles(text: string): ProviderCandle[] {
  const result: ProviderCandle[] = [];
  const matches = text.matchAll(/v_(?:sh|sz|bj)(\d{6})="([\s\S]*?)";/g);
  for (const match of matches) {
    const values = match[2].split('~');
    const date = normalizeQuoteDate(values[30]);
    const open = Number(values[5]);
    const high = Number(values[33]);
    const low = Number(values[34]);
    const close = Number(values[3]);
    const previousClose = Number(values[4]);
    const volumeLots = Number(values[36] || values[6]);
    const amountWan = Number(values[37]);
    const turnoverRatePct = Number(values[38]);
    if (
      !date
      || [open, high, low, close, previousClose, volumeLots].some(
        (value) => !Number.isFinite(value),
      )
      || open <= 0
      || high <= 0
      || low <= 0
      || close <= 0
    ) {
      continue;
    }
    result.push({
      symbol: match[1],
      date,
      open,
      high,
      low,
      close,
      previousClose,
      volume: volumeLots * 100,
      ...(Number.isFinite(amountWan) ? { turnover: amountWan * 10_000 } : {}),
      ...(Number.isFinite(turnoverRatePct) ? { turnoverRatePct } : {}),
    });
  }
  return result;
}

function toTencentQuoteCode(symbol: string, market: string): string {
  const normalized = symbol.trim();
  if (market.toUpperCase() === 'BJ') return `bj${normalized}`;
  return toTencentCode(normalized, market);
}

export function toTencentCode(symbol: string, market?: string): string {
  const value = symbol.trim().toLowerCase();
  if (/^(sh|sz)\d{6}$/.test(value)) return value;
  const suffixMatch = value.match(/^(\d{6})\.(sh|sz)$/);
  if (suffixMatch) return `${suffixMatch[2]}${suffixMatch[1]}`;
  if (!/^\d{6}$/.test(value)) {
    throw new ProviderError(`暂不支持的腾讯证券代码：${symbol}`, 'invalid_params', false);
  }
  const prefix = market?.toUpperCase() === 'SH'
    ? 'sh'
    : market?.toUpperCase() === 'SZ'
      ? 'sz'
      : SH_INDEX_SYMBOLS.has(value) ? 'sh'
      : /^[569]/.test(value) ? 'sh' : 'sz';
  return `${prefix}${value}`;
}

function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function formatISODate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatISODate(date);
}

function splitDateRange(start: string, end: string): Array<{ start: string; end: string }> {
  const ranges: Array<{ start: string; end: string }> = [];
  let cursor = start;
  while (cursor <= end) {
    const windowEnd = addDays(cursor, MAX_WINDOW_DAYS - 1);
    const boundedEnd = windowEnd < end ? windowEnd : end;
    ranges.push({ start: cursor, end: boundedEnd });
    cursor = addDays(boundedEnd, 1);
  }
  return ranges;
}

function stripMarketPrefix(code: string): string {
  return code.replace(/^(sh|sz)/, '');
}

function marketFromCode(code: string): string {
  return code.startsWith('sh') ? 'SH' : 'SZ';
}

function inferInstrumentType(code: string): string {
  const symbol = stripMarketPrefix(code);
  if ((code.startsWith('sh') && symbol.startsWith('000')) ||
      (code.startsWith('sz') && symbol.startsWith('399'))) return 'index';
  if (/^(1[568]|5[168])/.test(symbol)) return 'etf';
  return 'stock';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
