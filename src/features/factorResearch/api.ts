import { apiFetch } from '@/api/client';

export interface FactorDefinition {
  id: string;
  name: string;
  description: string;
  direction: 'higher-is-better' | 'lower-is-better' | 'research';
  dependencies: string[];
  warmupDays: number;
  expression: { type: 'builtin'; id: string };
}

export interface FactorCatalogItem {
  definition: FactorDefinition;
  versionId: string;
  version: number;
  checksum: string;
  publishedAt: string;
}

export interface FactorRunSummary {
  id: string;
  factorVersionId: string;
  snapshotId: string;
  universeId: string;
  status: 'completed' | 'failed' | 'running' | 'pending';
  dateStart: string;
  dateEnd: string;
  preprocessingConfig: Record<string, unknown>;
  labelConfig: { horizonDays?: number };
  runConfig: FactorRunRequest;
  totalDates: number;
  completedDates: number;
  artifactUri?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface FactorRunRequest {
  factorId: string;
  startDate: string;
  endDate: string;
  horizonDays: number;
  layers: number;
  markets?: string[];
  symbols?: string[];
  minDailyAmount?: number;
}

export interface CompositeFactorRunRequest {
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

export interface FactorReport {
  factor: FactorDefinition;
  snapshotId: string;
  sourceVersion: string;
  config: FactorRunRequest;
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
  artifactPath?: string;
}

export interface CompositeFactorWeight {
  factorId: string;
  weight: number;
  source: 'equal' | 'ic' | 'rankIc' | 'manual' | 'fallback-equal';
  trainingIc: number | null;
  trainingRankIc: number | null;
}

export interface FactorCorrelationMetric {
  factorA: string;
  factorB: string;
  correlation: number | null;
  sampleCount: number;
}

export interface CompositeFactorReport {
  factors: FactorDefinition[];
  snapshotId: string;
  sourceVersion: string;
  config: CompositeFactorRunRequest;
  summary: FactorReport['summary'] & {
    factorCount: number;
    averageAbsCorrelation: number | null;
  };
  weights: CompositeFactorWeight[];
  sampleSplit?: {
    train: FactorReport['summary'];
    validation: FactorReport['summary'];
  };
  correlations: FactorCorrelationMetric[];
  daily: DailyFactorMetric[];
  layers: LayerMetric[];
  createdAt: string;
  artifactPath?: string;
}

export interface FactorRunResponse {
  runId: string;
  reportId: string;
  report: FactorReport;
}

export interface CompositeFactorRunResponse {
  runId: string;
  reportId: string;
  report: CompositeFactorReport;
}

export interface FactorRunReportDetail {
  run: FactorRunSummary;
  reportRecord: {
    id: string;
    runId: string;
    summaryMetrics: Record<string, unknown>;
    reportUri: string;
    createdAt: string;
  };
  report: FactorReport | CompositeFactorReport;
}

export function fetchFactors() {
  return apiFetch<{ items: FactorCatalogItem[] }>('/api/factors', { timeoutMs: 60000 });
}

export function fetchFactorRuns(limit = 20) {
  return apiFetch<{ items: FactorRunSummary[] }>(`/api/factor-runs?limit=${limit}`, { timeoutMs: 60000 });
}

export function runFactorResearch(input: FactorRunRequest) {
  return apiFetch<FactorRunResponse>('/api/factor-runs', {
    method: 'POST',
    body: JSON.stringify(input),
    timeoutMs: 120000,
  });
}

export function runCompositeFactorResearch(input: CompositeFactorRunRequest) {
  return apiFetch<CompositeFactorRunResponse>('/api/factor-composites', {
    method: 'POST',
    body: JSON.stringify(input),
    timeoutMs: 120000,
  });
}

export function fetchFactorRunReport(runId: string) {
  return apiFetch<FactorRunReportDetail>(`/api/factor-runs/${runId}/report`, { timeoutMs: 60000 });
}
