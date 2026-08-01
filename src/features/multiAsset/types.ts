export type MultiAssetRunStatus = 'queued' | 'running' | 'completed' | 'failed'
  | 'retry_wait' | 'dead_letter' | 'cancelled';

export interface SnapshotMultiAssetConfig {
  universeSpec?: {
    type: 'index'; indexCode: '000300' | '000905';
  } | {
    type: 'all_a'; markets: Array<'SH' | 'SZ' | 'BJ'>;
    minHistoryDays: number; minValidBars20: number; maxSuspendedDays20: number;
    minAverageAmount20: number; excludeRiskNames: boolean;
  };
  /** Read-only compatibility for plans frozen before universeSpec was introduced. */
  indexCode?: '000300' | '000905';
  startDate: string;
  endDate: string;
  frequency: 'weekly' | 'monthly';
  topN: number;
  weighting: 'equal' | 'score';
  maxGrossExposure: number;
  maxSingleWeight: number;
  minCashWeight: number;
  factorVersionId?: string;
  factorPlan?: {
    protocolVersion: '1.0';
    weighting: 'equal' | 'manual' | 'training_ic' | 'training_rank_ic';
    trainedThrough?: string;
    validationStartsAt?: string;
    factors: Array<{
      factorId: string; factorVersion: string; direction: 'higher' | 'lower';
      missing: 'exclude' | 'cross_sectional_median';
      winsorization?: { method: 'percentile'; lower: number; upper: number };
      normalization: 'percentile' | 'zscore'; weight: number;
    }>;
  };
  fundamentalFields?: Array<'roe' | 'revenue_growth' | 'net_profit_growth' | 'debt_to_assets' | 'operating_cash_flow_quality' | 'gross_margin' | 'free_cash_flow_to_enterprise_value'>;
  fundamentalMaxStalenessDays?: number;
  optimizerSpec?: {
    protocolVersion: '1.0';
    objective: 'expected_return_minus_risk_and_turnover';
    mode: 'baseline' | 'constrained';
    riskAversion: number; turnoverPenalty: number; maxTurnover: number; maxHoldings: number;
    minPositionWeight?: number;
    solver: { name: 'deterministic_projection'; version: '1.0'; tolerance: number; maxIterations: number; seed: number };
    industryNeutral?: {
      protocolVersion: '1.0'; taxonomy: 'SW2021'; level: 1;
      benchmark: 'universe_equal' | 'index_weight'; maxActiveDeviation: number; allowUnknown: boolean;
      absoluteBounds?: Record<string, { min?: number; max?: number }>;
    };
  };
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
    factorPlan?: SnapshotMultiAssetConfig['factorPlan'];
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
    protocolVersion: '1.0' | '1.1' | '1.2';
    planHash: string;
    decisions: Array<{
      decisionDate: string;
      executableFrom: string;
      featureEvidence: Array<{
        instrumentKey: string;
        featureValue: number | null;
        normalizedFactors?: Record<string, number>;
        fundamentalEvidence?: {
          reportPeriod: string | null; announcementDate: string | null; sourceVersion: string | null;
          ageDays: number | null; missingFields: string[];
        };
        industryEvidence?: {
          taxonomy: 'SW2021'; level1Code: string | null; level1Name: string | null;
          effectiveFrom: string | null; effectiveTo: string | null; sourceVersion: string | null;
        };
      }>;
      targets: Array<{ instrumentKey: string; targetWeight: number; rank: number; score: number }>;
      optimizerResult?: {
        status: 'solved' | 'infeasible' | 'timeout' | 'numerical';
        turnover: number; grossExposure: number;
        comparison?: {
          baseline: { expectedReturn: number; riskProxy: number; turnover: number; concentration: number };
          optimized: { expectedReturn: number; riskProxy: number; turnover: number; concentration: number };
        } | null;
        weights: Array<{
          instrumentKey: string; baselineWeight: number; optimizedWeight: number;
          previousWeight: number; industryCode: string | null;
        }>;
        industryExposure?: Record<string, number>;
        baselineIndustryExposure?: Record<string, number>;
        benchmarkIndustryExposure?: Record<string, number>;
        constraintMargins: Record<string, number>;
        conflicts: string[];
      };
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
  kind: 'rebalance_plan' | 'execution_result' | 'extension_report';
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
