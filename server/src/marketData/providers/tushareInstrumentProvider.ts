import type {
  AdjustmentFactor,
  AdjustmentRequest,
  CalendarRequest,
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

const API_URL = 'https://api.tushare.pro';
const STOCK_BASIC_FIELDS = [
  'ts_code',
  'symbol',
  'name',
  'industry',
  'market',
  'exchange',
  'list_status',
  'list_date',
  'delist_date',
].join(',');
const LIST_STATUSES = ['L', 'P', 'D'] as const;

interface TusharePayload {
  code?: number;
  msg?: string;
  data?: {
    fields?: string[];
    items?: unknown[][];
  };
}

export class TushareInstrumentProvider implements MarketDataProvider {
  readonly id = 'tushare-instruments';
  readonly name = 'Tushare 证券主表';
  readonly type = 'live' as const;

  constructor(
    private readonly token: string,
    private readonly apiUrl = API_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getCapabilities(): ProviderCapabilities {
    return {
      supportedMarkets: ['SH', 'SZ', 'BJ'],
      supportedDataTypes: ['instruments'],
      maxDateRangeDays: 0,
      rateLimit: {
        requestsPerMinute: 60,
        requestsPerDay: 10000,
      },
    };
  }

  async fetchInstruments(request: InstrumentRequest): Promise<InstrumentPage> {
    if (request.cursor) return { items: [], hasMore: false };
    if (!this.token.trim()) {
      throw new ProviderError('TUSHARE_TOKEN 未配置，无法刷新证券主表', 'auth', false);
    }

    const batches: ProviderInstrument[][] = [];
    for (const listStatus of LIST_STATUSES) {
      batches.push(await this.queryStockBasic(listStatus));
    }
    const deduplicated = new Map<string, ProviderInstrument>();
    for (const batch of batches) {
      for (const item of batch) {
        const key = `${item.market}:${item.symbol}:${item.type}`;
        const previous = deduplicated.get(key);
        if (!previous || statusPriority(item.status) > statusPriority(previous.status)) {
          deduplicated.set(key, item);
        }
      }
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
    if (request.types?.length) {
      const types = new Set(request.types.map((item) => item.toLowerCase()));
      items = items.filter((item) => types.has(item.type.toLowerCase()));
    }

    items.sort((left, right) => (
      left.market.localeCompare(right.market)
      || left.symbol.localeCompare(right.symbol)
    ));
    return { items, hasMore: false };
  }

  async fetchTradingCalendar(_request: CalendarRequest): Promise<TradingDay[]> {
    throw unsupported('trading calendar');
  }

  async fetchDailyCandles(_request: DailyCandleRequest): Promise<ProviderCandle[]> {
    throw unsupported('daily candles');
  }

  async fetchAdjustmentFactors(_request: AdjustmentRequest): Promise<AdjustmentFactor[]> {
    throw unsupported('adjustment factors');
  }

  private async queryStockBasic(
    listStatus: typeof LIST_STATUSES[number],
  ): Promise<ProviderInstrument[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_name: 'stock_basic',
          token: this.token,
          params: {
            exchange: '',
            list_status: listStatus,
            limit: 6000,
            offset: 0,
          },
          fields: STOCK_BASIC_FIELDS,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ProviderError(
        `Tushare 证券主表请求失败：${error instanceof Error ? error.message : String(error)}`,
        'network',
        true,
        error,
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        `Tushare 证券主表请求返回 HTTP ${response.status}`,
        response.status === 429 ? 'rate_limit' : 'network',
        response.status >= 500 || response.status === 429,
      );
    }

    const payload = await response.json() as TusharePayload;
    if (payload.code !== 0) {
      const message = payload.msg || `code=${payload.code ?? 'unknown'}`;
      const authError = /token|权限|抱歉/i.test(message);
      throw new ProviderError(
        `Tushare stock_basic 失败：${message}`,
        authError ? 'auth' : 'data_error',
        false,
        payload,
      );
    }
    const fields = payload.data?.fields ?? [];
    const items = payload.data?.items ?? [];
    return items
      .map((row) => mapRow(fields, row, listStatus))
      .filter((item): item is ProviderInstrument => item !== null);
  }
}

function mapRow(
  fields: string[],
  row: unknown[],
  listStatus: typeof LIST_STATUSES[number],
): ProviderInstrument | null {
  const record = Object.fromEntries(fields.map((field, index) => [field, row[index]]));
  const tsCode = String(record.ts_code ?? '').toUpperCase();
  const symbol = String(record.symbol ?? tsCode.split('.')[0] ?? '').replace(/\D/g, '');
  const market = marketFromRecord(tsCode, String(record.exchange ?? ''));
  if (!market || !/^\d{6}$/.test(symbol)) return null;

  const status = listStatus === 'D'
    ? 'delisted'
    : listStatus === 'P' ? 'pending' : 'active';
  return {
    symbol,
    name: String(record.name ?? symbol).trim() || symbol,
    market,
    type: 'stock',
    industry: optionalText(record.industry),
    listDate: normalizeDate(record.list_date),
    delistDate: normalizeDate(record.delist_date),
    status,
  };
}

function marketFromRecord(tsCode: string, exchange: string): 'SH' | 'SZ' | 'BJ' | null {
  const suffix = tsCode.split('.')[1];
  if (suffix === 'SH' || exchange === 'SSE') return 'SH';
  if (suffix === 'SZ' || exchange === 'SZSE') return 'SZ';
  if (suffix === 'BJ' || exchange === 'BSE') return 'BJ';
  return null;
}

function normalizeDate(value: unknown): string | undefined {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 8);
  if (digits.length !== 8) return undefined;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function optionalText(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function statusPriority(status: ProviderInstrument['status']): number {
  if (status === 'active') return 3;
  if (status === 'pending') return 2;
  if (status === 'suspended') return 1;
  return 0;
}

function unsupported(capability: string): ProviderError {
  return new ProviderError(
    `Tushare 证券主表 provider 不提供 ${capability}`,
    'invalid_params',
    false,
  );
}
