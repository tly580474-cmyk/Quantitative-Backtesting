// N3.4 假设管理 UI 类型（与 server/src/experiments/hypothesis/hypothesisSchema.ts 对应）。

export type HypothesisStatus = 'draft' | 'evaluated' | 'rejected';

export interface HypothesisPlan {
  protocolVersion: '1.0';
  strategyType: 'dual_ma';
  params: Record<string, number | boolean | string>;
  name: string;
  description: string;
  rationale: string;
  capabilityVersion: string;
}

export interface HypothesisEvaluationSummary {
  authority: 'screening_only';
  finalEquity: number;
  totalReturn: number;
  tradeCount: number;
  datasetSnapshot: {
    id: string;
    name?: string;
    symbol: string;
    startTime: string;
    endTime: string;
    checksum: string;
  };
}

export interface Hypothesis {
  id: string;
  plan: HypothesisPlan;
  status: HypothesisStatus;
  mappedExperimentVersionId: string | null;
  lastRunId: string | null;
  validationStatus: 'pending' | 'candidate' | 'rejected' | null;
  evaluationSummary: HypothesisEvaluationSummary | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HypothesisEvaluationRequest {
  datasetSnapshot: HypothesisEvaluationSummary['datasetSnapshot'];
  candles: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }>;
  config: {
    backtestMode: 'strategy';
    initialCapital: number;
    tradingDays: number;
    positionSizing: { type: 'percent'; value: number };
    commissionRate: number;
    minimumCommission: number;
    sellTaxRate: number;
    slippageBps: number;
    tradingUnitMode: 'stock' | 'index';
    minimumTradeAmount: number;
    dca: { amount: number; frequency: 'daily' | 'weekly' | 'monthly' };
    execution: 'next_open';
    forceCloseAtEnd: boolean;
  };
  engineVersion?: string;
}
