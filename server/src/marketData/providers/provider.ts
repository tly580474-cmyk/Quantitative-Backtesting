// ─── Provider Capabilities ─────────────────────────────────────────
export interface ProviderCapabilities {
  supportedMarkets: string[];
  supportedDataTypes: DataType[];
  maxDateRangeDays: number;
  rateLimit: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
}

export type DataType = 'instruments' | 'calendar' | 'daily_candles' | 'adjustment_factors';

// ─── Request Types ─────────────────────────────────────────────────
export interface InstrumentRequest {
  market?: string;
  symbol?: string;
  types?: string[];
  cursor?: string;
  pageSize?: number;
}

export interface CalendarRequest {
  market: string;
  startDate: string;
  endDate: string;
}

export interface DailyCandleRequest {
  symbols: string[];
  startDate: string;
  endDate: string;
  adjustment?: 'none' | 'qfq' | 'hfq';
}

export interface AdjustmentRequest {
  symbols: string[];
  startDate: string;
  endDate: string;
}

// ─── Response Types ────────────────────────────────────────────────
export interface ProviderInstrument {
  symbol: string;
  name: string;
  market: string;
  type: string;
  listDate?: string;
  delistDate?: string;
}

export interface InstrumentPage {
  items: ProviderInstrument[];
  cursor?: string;
  hasMore: boolean;
}

export interface TradingDay {
  date: string;
  isOpen: boolean;
  sessionMetadata?: Record<string, unknown>;
}

export interface ProviderCandle {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
}

export interface AdjustmentFactor {
  symbol: string;
  date: string;
  factor: number;
}

// ─── Error Classification ──────────────────────────────────────────
export type ProviderErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'invalid_params'
  | 'quota_exceeded'
  | 'data_error';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly category: ProviderErrorCategory,
    public readonly retryable: boolean,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ─── Provider Interface ────────────────────────────────────────────
export interface MarketDataProvider {
  readonly id: string;
  readonly name: string;
  readonly type: 'live' | 'mock';

  getCapabilities(): ProviderCapabilities;

  fetchInstruments(request: InstrumentRequest): Promise<InstrumentPage>;

  fetchTradingCalendar(request: CalendarRequest): Promise<TradingDay[]>;

  fetchDailyCandles(request: DailyCandleRequest): Promise<ProviderCandle[]>;

  fetchAdjustmentFactors(
    request: AdjustmentRequest,
  ): Promise<AdjustmentFactor[]>;
}
