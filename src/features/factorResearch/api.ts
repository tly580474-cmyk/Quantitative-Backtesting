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
  status: 'completed' | 'failed' | 'running' | 'pending' | 'canceled' | 'cancelled';
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
  failedRunId?: string;
}

export interface CompositeFactorRunResponse {
  runId: string;
  reportId: string;
  report: CompositeFactorReport;
  failedRunId?: string;
}

export interface FactorRunRetryResponse {
  runId: string;
  reportId: string;
  retriedFromRunId: string;
  report: FactorReport | CompositeFactorReport;
  failedRunId?: string;
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
  report: Omit<FactorReport, 'daily'> | Omit<CompositeFactorReport, 'daily'>;
  series: {
    daily: { total: number };
  };
}

export interface FactorRunDailySeries {
  items: DailyFactorMetric[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FactorReportInterpretation {
  model: string;
  generatedAt: string;
  interpretation: string;
}

export interface ResearchSnapshotFreshness {
  status: 'current' | 'stale' | 'inconsistent' | 'unavailable';
  snapshot: {
    snapshotId: string | null;
    rowCount: number | null;
    maxDate: string | null;
  };
  mysql: {
    rowCount: number;
    maxDate: string | null;
  };
  missingDates?: string[];
  message: string;
}

export interface ResearchSnapshotUpdateResponse {
  before: ResearchSnapshotFreshness;
  manifest: {
    snapshotId: string;
    rowCount: number;
    maxDate: string;
    partitions: Array<{ relativePath: string; rows: number; minDate: string; maxDate: string }>;
  };
  verification: {
    status: 'validated';
    snapshotId: string;
    rowCount: number;
  };
  after: ResearchSnapshotFreshness;
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

export function cancelFactorRun(runId: string) {
  return apiFetch<{ run: FactorRunSummary }>(`/api/factor-runs/${runId}/cancel`, {
    method: 'POST',
    timeoutMs: 60000,
  });
}

export function retryFactorRun(runId: string) {
  return apiFetch<FactorRunRetryResponse>(`/api/factor-runs/${runId}/retry`, {
    method: 'POST',
    timeoutMs: 120000,
  });
}

export function fetchFactorRunDailySeries(runId: string, page = 1, pageSize = 100) {
  return apiFetch<FactorRunDailySeries>(
    `/api/factor-runs/${runId}/report/daily?page=${page}&pageSize=${pageSize}`,
    { timeoutMs: 60000 },
  );
}

export function interpretFactorRunReport(runId: string) {
  return apiFetch<FactorReportInterpretation>(`/api/factor-runs/${runId}/interpret`, {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: 120000,
  });
}

export function fetchResearchSnapshotFreshness() {
  return apiFetch<ResearchSnapshotFreshness>('/api/research-snapshots/freshness', { timeoutMs: 60000 });
}

export function updateResearchSnapshot() {
  return apiFetch<ResearchSnapshotUpdateResponse>('/api/research-snapshots/update', {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: 300000,
  });
}
