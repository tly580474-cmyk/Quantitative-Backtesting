import type {
  AdjustmentFactor,
  AdjustmentRequest,
  CalendarRequest,
  CurrentDailyCandleRequest,
  DailyCandleRequest,
  InstrumentPage,
  InstrumentRequest,
  MarketDataProvider,
  ProviderCapabilities,
  ProviderCandle,
  ProviderInstrument,
  TradingDay,
} from './provider.js';
import { ProviderError } from './provider.js';

const BASE_URL = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

interface SinaInstrumentRow {
  symbol?: string;
  code?: string;
  name?: string;
  trade?: string | number;
  settlement?: string | number;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  volume?: string | number;
  amount?: string | number;
  turnoverratio?: string | number;
  mktcap?: string | number;
  nmc?: string | number;
  per?: string | number;
  pb?: string | number;
}

interface SinaKlineRow {
  day?: string;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  volume?: string | number;
}

interface SinaKlinePayload {
  result?: {
    status?: { code?: number };
    data?: SinaKlineRow[];
  };
}

export class SinaInstrumentProvider implements MarketDataProvider {
  readonly id = 'sina-instruments';
  readonly name = '新浪财经证券主表';
  readonly type = 'live' as const;

  constructor(
    private readonly baseUrl = BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getCapabilities(): ProviderCapabilities {
    return {
      supportedMarkets: ['SH', 'SZ', 'BJ'],
      supportedDataTypes: ['instruments', 'daily_candles'],
      maxDateRangeDays: 1400,
      rateLimit: {
        requestsPerMinute: 120,
        requestsPerDay: 10000,
      },
    };
  }

  async fetchInstruments(request: InstrumentRequest): Promise<InstrumentPage> {
    if (request.cursor) return { items: [], hasMore: false };
    const expectedCount = await this.fetchCount();
    if (expectedCount <= 0) {
      throw new ProviderError('新浪财经证券主表返回无效数量', 'data_error', true);
    }
    const pages = Math.ceil(expectedCount / PAGE_SIZE);
    if (pages > MAX_PAGES) {
      throw new ProviderError(
        `新浪财经证券主表页数异常：${pages}`,
        'data_error',
        false,
      );
    }

    const rows: SinaInstrumentRow[] = [];
    for (let page = 1; page <= pages; page++) {
      rows.push(...await this.fetchPage(page));
    }
    if (rows.length < Math.floor(expectedCount * 0.98)) {
      throw new ProviderError(
        `新浪财经证券主表预计 ${expectedCount} 条，实际仅返回 ${rows.length} 条`,
        'data_error',
        true,
      );
    }

    const deduplicated = new Map<string, ProviderInstrument>();
    for (const row of rows) {
      const item = mapRow(row);
      if (!item) continue;
      deduplicated.set(`${item.market}:${item.symbol}`, item);
    }
    let items = [...deduplicated.values()];
    if (request.market) {
      const market = request.market.toUpperCase();
      items = items.filter((item) => item.market === market);
    }
    if (request.symbol) {
      const symbol = request.symbol.replace(/\D/g, '').padStart(6, '0');
      items = items.filter((item) => item.symbol === symbol);
    }
    if (request.types?.length && !request.types.some((type) => type.toLowerCase() === 'stock')) {
      items = [];
    }
    items.sort((left, right) => (
      left.market.localeCompare(right.market)
      || left.symbol.localeCompare(right.symbol)
    ));
    return { items, hasMore: false };
  }

  async enrichInstruments(
    instruments: ProviderInstrument[],
  ): Promise<ProviderInstrument[]> {
    const result = [...instruments];
    const workerCount = Math.min(4, result.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < result.length) {
        const index = cursor++;
        const item = result[index];
        try {
          const listDate = await this.fetchListingDate(item.symbol);
          result[index] = { ...item, ...(listDate ? { listDate } : {}) };
        } catch {
          // Listing-date enrichment is best effort. The new security must still
          // be discoverable and can be retried by the next master sync.
        }
      }
    }));
    return result;
  }

  async fetchCurrentDailyCandles(
    request: CurrentDailyCandleRequest,
  ): Promise<ProviderCandle[]> {
    const expectedCount = await this.fetchCount();
    const pages = Math.ceil(expectedCount / PAGE_SIZE);
    const rows: SinaInstrumentRow[] = [];
    for (let page = 1; page <= pages; page++) {
      rows.push(...await this.fetchPage(page));
    }
    if (rows.length < Math.floor(expectedCount * 0.98)) {
      throw new ProviderError(
        `新浪财经全市场行情预计 ${expectedCount} 条，实际仅返回 ${rows.length} 条`,
        'data_error',
        true,
      );
    }
    const targets = new Set(request.instruments.map((item) => (
      `${item.market.toUpperCase()}:${normalizeSymbol(item.symbol)}`
    )));
    const tradeDate = chinaTradeDate();
    return rows.map((row): ProviderCandle | null => {
      const identity = rowIdentity(row);
      if (!identity || !targets.has(`${identity.market}:${identity.symbol}`)) return null;
      const open = positiveNumber(row.open);
      const high = positiveNumber(row.high);
      const low = positiveNumber(row.low);
      const close = positiveNumber(row.trade);
      const previousClose = positiveNumber(row.settlement);
      const volume = finiteNumber(row.volume);
      const turnover = finiteNumber(row.amount);
      const turnoverRatePct = finiteNumber(row.turnoverratio);
      if (
        open == null
        || high == null
        || low == null
        || close == null
        || volume == null
        || turnover == null
        || turnoverRatePct == null
      ) return null;
      const totalMarketCapWan = finiteNumber(row.mktcap);
      const floatMarketCapWan = finiteNumber(row.nmc);
      return {
        symbol: identity.symbol,
        date: tradeDate,
        open,
        high,
        low,
        close,
        ...(previousClose == null ? {} : { previousClose }),
        volume,
        turnover,
        turnoverRatePct,
        totalMarketCap: totalMarketCapWan == null ? undefined : totalMarketCapWan * 10_000,
        floatMarketCap: floatMarketCapWan == null ? undefined : floatMarketCapWan * 10_000,
        peTtm: finiteNumber(row.per) ?? undefined,
        pb: finiteNumber(row.pb) ?? undefined,
      };
    }).filter((row): row is ProviderCandle => row !== null);
  }

  async fetchTradingCalendar(_request: CalendarRequest): Promise<TradingDay[]> {
    throw unsupported('trading calendar');
  }

  async fetchDailyCandles(request: DailyCandleRequest): Promise<ProviderCandle[]> {
    const batches = await Promise.all(request.symbols.map(async (symbol) => {
      const params = new URLSearchParams({
        symbol: toSinaSymbol(symbol),
        scale: '240',
        ma: 'no',
        datalen: '1023',
      });
      const response = await this.fetchImpl(
        `https://quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData?${params.toString()}`,
        {
          headers: {
            referer: 'https://finance.sina.com.cn/',
            'user-agent': 'quant-backtest/instrument-master',
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        throw new ProviderError(
          `新浪日 K 请求 ${symbol} 返回 HTTP ${response.status}`,
          response.status === 429 ? 'rate_limit' : 'network',
          response.status >= 500 || response.status === 429,
        );
      }
      const payload = await response.json() as SinaKlinePayload;
      if (payload.result?.status?.code !== 0) return [];
      const rows = (payload.result?.data ?? [])
        .filter((row) => (
          typeof row.day === 'string'
          && row.day >= request.startDate
          && row.day <= request.endDate
        ));
      return rows.map((row, index): ProviderCandle | null => {
        const open = finiteNumber(row.open);
        const high = finiteNumber(row.high);
        const low = finiteNumber(row.low);
        const close = finiteNumber(row.close);
        const volume = finiteNumber(row.volume);
        if (
          !row.day
          || open == null
          || high == null
          || low == null
          || close == null
          || volume == null
        ) return null;
        const previousClose = index > 0 ? finiteNumber(rows[index - 1].close) : undefined;
        return {
          symbol: normalizeSymbol(symbol),
          date: row.day,
          open,
          high,
          low,
          close,
          ...(previousClose == null ? {} : { previousClose }),
          volume,
        };
      }).filter((row): row is ProviderCandle => row !== null);
    }));
    return batches.flat();
  }

  async fetchAdjustmentFactors(_request: AdjustmentRequest): Promise<AdjustmentFactor[]> {
    throw unsupported('adjustment factors');
  }

  private async fetchCount(): Promise<number> {
    const payload = await this.request('Market_Center.getHQNodeStockCount?node=hs_a');
    const count = Number(JSON.parse(payload));
    return Number.isInteger(count) ? count : 0;
  }

  private async fetchPage(page: number): Promise<SinaInstrumentRow[]> {
    const params = new URLSearchParams({
      page: String(page),
      num: String(PAGE_SIZE),
      sort: 'symbol',
      asc: '1',
      node: 'hs_a',
      symbol: '',
      _s_r_a: 'page',
    });
    const payload = await this.request(`Market_Center.getHQNodeData?${params.toString()}`);
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed)) {
      throw new ProviderError(
        `新浪财经证券主表第 ${page} 页格式错误`,
        'data_error',
        true,
      );
    }
    return parsed as SinaInstrumentRow[];
  }

  private async request(path: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        headers: {
          referer: 'https://vip.stock.finance.sina.com.cn/',
          'user-agent': 'quant-backtest/instrument-master',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new ProviderError(
        `新浪财经证券主表请求失败：${error instanceof Error ? error.message : String(error)}`,
        'network',
        true,
        error,
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        `新浪财经证券主表请求返回 HTTP ${response.status}`,
        response.status === 429 ? 'rate_limit' : 'network',
        response.status >= 500 || response.status === 429,
      );
    }
    return response.text();
  }

  private async fetchListingDate(symbol: string): Promise<string | undefined> {
    const response = await this.fetchImpl(
      `https://vip.stock.finance.sina.com.cn/corp/go.php/vCI_CorpInfo/stockid/${symbol}.phtml`,
      {
        headers: {
          referer: 'https://finance.sina.com.cn/',
          'user-agent': 'quant-backtest/instrument-master',
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) return undefined;
    const html = await response.text();
    const match = /InMarketDate=\d+[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*</i.exec(html);
    return match?.[1];
  }
}

function mapRow(row: SinaInstrumentRow): ProviderInstrument | null {
  const identity = rowIdentity(row);
  if (!identity) return null;
  return {
    symbol: identity.symbol,
    name: String(row.name ?? identity.symbol).trim() || identity.symbol,
    market: identity.market,
    type: 'stock',
    status: 'active',
  };
}

function rowIdentity(
  row: SinaInstrumentRow,
): { symbol: string; market: 'SH' | 'SZ' | 'BJ' } | null {
  const sourceSymbol = String(row.symbol ?? '').toLowerCase();
  const symbol = String(row.code ?? sourceSymbol.slice(2)).replace(/\D/g, '');
  const prefix = sourceSymbol.slice(0, 2);
  const market = prefix === 'sh' ? 'SH' : prefix === 'sz' ? 'SZ' : prefix === 'bj' ? 'BJ' : null;
  return market && /^\d{6}$/.test(symbol) ? { symbol, market } : null;
}

function normalizeSymbol(value: string): string {
  return value.replace(/\D/g, '').slice(-6);
}

function toSinaSymbol(value: string): string {
  const code = normalizeSymbol(value);
  if (/^(4|8|920)/.test(code)) return `bj${code}`;
  if (/^(5|6|9)/.test(code)) return `sh${code}`;
  return `sz${code}`;
}

function finiteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function positiveNumber(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric != null && numeric > 0 ? numeric : null;
}

function chinaTradeDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function unsupported(capability: string): ProviderError {
  return new ProviderError(
    `新浪财经证券主表 provider 不提供 ${capability}`,
    'invalid_params',
    false,
  );
}
