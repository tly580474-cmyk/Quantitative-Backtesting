export type FactorDirection = 'higher-is-better' | 'lower-is-better' | 'research';

export type FactorDependency =
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'previousClose'
  | 'volume'
  | 'amount'
  | 'turnoverRatePct'
  | 'totalMarketCap'
  | 'industry';

export interface BuiltinFactorExpression {
  type: 'builtin';
  id: string;
}

export type FactorAstTerminal = Exclude<FactorDependency, 'industry'> | 'returns' | 'vwap' | 'log_mktcap';

export type FactorAstNode =
  | { type: 'terminal'; name: FactorAstTerminal }
  | { type: 'constant'; value: number }
  | { type: 'operator'; op: string; args: FactorAstNode[]; window?: number };

export interface AstFactorExpression {
  type: 'ast';
  version: 1;
  root: FactorAstNode;
}

export type FactorExpression = BuiltinFactorExpression | AstFactorExpression;

export interface FactorDefinition {
  id: string;
  name: string;
  description: string;
  direction: FactorDirection;
  dependencies: FactorDependency[];
  warmupDays: number;
  expression: FactorExpression;
}

export interface FactorRunConfig {
  factorId: string;
  startDate: string;
  endDate: string;
  horizonDays: number;
  layers: number;
  markets?: string[];
  symbols?: string[];
  minDailyAmount?: number;
}

export interface CompositeFactorRunConfig {
  factorIds: string[];
  startDate: string;
  endDate: string;
  validationStartDate?: string;
  horizonDays: number;
  layers: number;
  weighting: 'equal' | 'ic' | 'rankIc' | 'manual';
  manualWeights?: Record<string, number>;
  markets?: string[];
  symbols?: string[];
  minDailyAmount?: number;
}

export interface DailyFactorMetric {
  tradeDate: string;
  sampleCount: number;
  ic: number | null;
  rankIc: number | null;
}

export interface LayerMetric {
  layer: number;
  sampleCount: number;
  averageReturn: number | null;
}

export interface FactorResearchReport {
  factor: FactorDefinition;
  snapshotId: string;
  sourceVersion: string;
  config: FactorRunConfig;
  summary: {
    sampleCount: number;
    tradingDays: number;
    averageIc: number | null;
    averageRankIc: number | null;
    icir: number | null;
    rankIcPositiveRate: number | null;
    longShortSpread: number | null;
  };
  daily: DailyFactorMetric[];
  layers: LayerMetric[];
  portfolio: {
    method: 'non-overlapping';
    holdingDays: number;
    observationCount: number;
    grossSharpe: number | null;
    netSharpe: number | null;
    stressedCostSharpe: number | null;
    maxDrawdown: number | null;
    costBpsPerLeg: number;
  };
  robustness: {
    coverageRate: number | null;
    sizeExposure: number | null;
    liquidityExposure: number | null;
    averageTopLayerTurnover: number | null;
    capacityEstimate: number | null;
    regimeRankIc: Array<{ startDate: string; endDate: string; averageRankIc: number | null }>;
    groupStability: Array<{
      dimension: 'market' | 'industry' | 'size' | 'regime';
      bucket: string;
      sampleCount: number;
      ic: number | null;
    }>;
  };
  createdAt: string;
}

export interface FactorCorrelationMetric {
  factorA: string;
  factorB: string;
  correlation: number | null;
  sampleCount: number;
}

export interface CompositeFactorWeight {
  factorId: string;
  weight: number;
  source: 'equal' | 'ic' | 'rankIc' | 'manual' | 'fallback-equal';
  trainingIc: number | null;
  trainingRankIc: number | null;
}

export interface CompositeFactorResearchReport {
  factors: FactorDefinition[];
  snapshotId: string;
  sourceVersion: string;
  config: CompositeFactorRunConfig;
  summary: FactorResearchReport['summary'] & {
    factorCount: number;
    averageAbsCorrelation: number | null;
  };
  weights: CompositeFactorWeight[];
  sampleSplit?: {
    train: FactorResearchReport['summary'];
    validation: FactorResearchReport['summary'];
  };
  correlations: FactorCorrelationMetric[];
  daily: DailyFactorMetric[];
  layers: LayerMetric[];
  createdAt: string;
}
