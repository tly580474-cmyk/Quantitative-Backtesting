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

export interface FactorRunResponse {
  runId: string;
  reportId: string;
  report: FactorReport;
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
