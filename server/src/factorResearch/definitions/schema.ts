export type FactorDirection = 'higher-is-better' | 'lower-is-better' | 'research';

export type FactorDependency =
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'previousClose'
  | 'volume'
  | 'amount'
  | 'turnoverRatePct';

export interface FactorExpression {
  type: 'builtin';
  id: string;
}

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
