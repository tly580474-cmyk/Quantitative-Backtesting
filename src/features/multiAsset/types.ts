export type MultiAssetRunStatus = 'queued' | 'running' | 'completed' | 'failed'
  | 'retry_wait' | 'dead_letter' | 'cancelled';

export interface SnapshotMultiAssetConfig {
  indexCode: '000300' | '000905';
  startDate: string;
  endDate: string;
  frequency: 'weekly' | 'monthly';
  topN: number;
  weighting: 'equal' | 'score';
  maxGrossExposure: number;
  maxSingleWeight: number;
  minCashWeight: number;
  factorVersionId?: string;
  strategyVersionId?: string;
}

export interface StoredMultiAssetPlan {
  id: string;
  name: string;
  status: 'frozen';
  snapshotId: string;
  planHash: string;
  plan: {
    featurePlan?: { featureId?: string; featureVersion?: string };
    executionPlan?: {
      commissionRate?: number;
      minimumCommission?: number;
      sellTaxRate?: number;
      slippageRate?: number;
    };
    portfolioPlan?: { lotSize?: number };
    governancePlan?: { factorVersionId?: string; strategyVersionId?: string; role: string };
  };
  snapshotConfig: SnapshotMultiAssetConfig;
  createdAt: string;
  updatedAt: string;
}

export interface MultiAssetOrder {
  tradeDate: string;
  instrumentKey: string;
  side: 'buy' | 'sell';
  quantity: number;
  fillPrice: number;
  grossAmount: number;
  fees: number;
  reason: 'rebalance';
}

export interface MultiAssetLedgerEntry {
  tradeDate: string;
  cash: number;
  marketValue: number;
  equity: number;
  cumulativeCosts: number;
  grossTraded: number;
  turnover: number;
  positions: Array<{
    instrumentKey: string;
    quantity: number;
    markPrice: number;
    marketValue: number;
  }>;
}

export interface StoredMultiAssetRun {
  id: string;
  planVersionId: string;
  status: MultiAssetRunStatus;
  idempotencyKey: string;
  inputHash: string;
  initialCash: number;
  progress: { stage: string; percent: number };
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  cancelRequestedAt: string | null;
  cancelledAt: string | null;
  rebalancePlan: null | {
    protocolVersion: '1.0';
    planHash: string;
    decisions: Array<{
      decisionDate: string;
      executableFrom: string;
      targets: Array<{ instrumentKey: string; targetWeight: number; rank: number; score: number }>;
    }>;
  };
  executionResult: null | {
    protocolVersion: '1.0';
    initialCash: number;
    orders: MultiAssetOrder[];
    ledger: MultiAssetLedgerEntry[];
  };
  resultHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface MultiAssetRunArtifact {
  id: string;
  runId: string;
  kind: 'rebalance_plan' | 'execution_result';
  contentHash: string;
  storageUri: string;
  byteSize: number;
  mediaType: string;
  createdAt: string;
}

export interface CreateMultiAssetPlanInput {
  name: string;
  config: SnapshotMultiAssetConfig;
}
