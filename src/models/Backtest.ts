import type { StrategySignal } from './Strategy';
import type { Trade } from './Trade';

export interface BacktestConfig {
  backtestMode: 'strategy' | 'dca';
  initialCapital: number;
  /** Number of most-recent trading days to include. 0 means all available data. */
  tradingDays: number;
  positionSizing: { type: 'percent'; value: number };
  commissionRate: number;
  minimumCommission: number;
  sellTaxRate: number;
  slippageBps: number;
  tradingUnitMode: 'stock' | 'index';
  /** Kept for backwards compatibility with results created before 3.5. */
  minimumTradeAmount: number;
  dca: {
    amount: number;
    frequency: 'daily' | 'weekly' | 'monthly';
  };
  execution: 'next_open';
  forceCloseAtEnd: boolean;
}

export interface EquityPoint {
  time: string;
  cash: number;
  marketValue: number;
  equity: number;
  drawdown: number;
  positionQuantity: number;
  /** Cumulative external cash contributed to the account. */
  contributedCapital?: number;
}

export interface BacktestMetrics {
  initialCapital: number;
  netContributions: number;
  finalEquity: number;
  totalReturn: number;
  annualizedReturn: number;
  annualizedVolatility: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownStart: string;
  maxDrawdownEnd: string;
  tradeCount: number;
  winRate: number;
  profitFactor: number;
  avgHoldingDays: number;
  totalCommission: number;
  totalTax: number;
  totalSlippage: number;
  benchmarkReturn: number;
  excessReturn: number;
  metricsNote?: string;
}

export interface BacktestResult {
  id: string;
  name: string;
  status: 'completed' | 'failed' | 'cancelled';
  datasetSnapshot: {
    id: string;
    name?: string;
    symbol: string;
    startTime: string;
    endTime: string;
    checksum: string;
  };
  strategyId: string;
  strategyVersion: string;
  strategyParams: Record<string, unknown>;
  config: BacktestConfig;
  startedAt: string;
  completedAt: string;
  metrics: BacktestMetrics;
  signals: StrategySignal[];
  trades: Trade[];
  equityCurve: EquityPoint[];
  error?: string;
}
