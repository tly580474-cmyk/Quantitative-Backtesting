import type { StrategySignal } from './Strategy';
import type { Trade } from './Trade';

export interface BacktestConfig {
  initialCapital: number;
  positionSizing: { type: 'percent'; value: number };
  commissionRate: number;
  minimumCommission: number;
  sellTaxRate: number;
  slippageBps: number;
  lotSize: number;
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
}

export interface BacktestMetrics {
  initialCapital: number;
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
}

export interface BacktestResult {
  id: string;
  name: string;
  status: 'completed' | 'failed' | 'cancelled';
  datasetSnapshot: {
    id: string;
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
