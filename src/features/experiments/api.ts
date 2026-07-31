import { apiFetch } from '@/api/client';
import type { BacktestResult } from '@/models';
import type {
  ConfirmExperimentRequest,
  CreateExperimentRunRequest,
  ExperimentRun,
  ExperimentVersion,
} from './types';

export async function confirmExperimentVersion(input: ConfirmExperimentRequest) {
  return apiFetch<{ experimentVersion: ExperimentVersion; reused: boolean }>(
    '/api/experiments/versions/confirm',
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function getExperimentCapabilityVersion(): Promise<string> {
  const registry = await apiFetch<{ capabilityVersion: string }>('/api/ai/strategy-capabilities');
  return registry.capabilityVersion;
}

export async function createExperimentRun(input: CreateExperimentRunRequest) {
  return apiFetch<{ run: ExperimentRun; reused: boolean }>(
    '/api/experiments/runs',
    { method: 'POST', body: JSON.stringify(input) },
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export async function hashBacktestResult(result: BacktestResult): Promise<string> {
  const payload = {
    datasetSnapshot: result.datasetSnapshot,
    strategyId: result.strategyId,
    strategyVersion: result.strategyVersion,
    strategyParams: result.strategyParams,
    config: result.config,
    metrics: result.metrics,
    signals: result.signals,
    trades: result.trades,
    equityCurve: result.equityCurve,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue(payload)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function completeExperimentRun(runId: string, result: BacktestResult) {
  return apiFetch<ExperimentRun>(`/api/experiments/runs/${runId}/complete`, {
    method: 'POST',
    body: JSON.stringify({
      backtestResultId: result.id,
      resultHash: await hashBacktestResult(result),
      validation: {
        compile: 'passed',
        executionTiming: 'close_to_next_open',
        goldenParityGate: 'passed',
      },
    }),
  });
}

export async function failExperimentRun(runId: string, message: string) {
  return apiFetch<ExperimentRun>(`/api/experiments/runs/${runId}/fail`, {
    method: 'POST',
    body: JSON.stringify({ errorCode: 'RUNTIME_FAILED', message }),
  });
}

export async function cancelExperimentRun(runId: string) {
  return apiFetch<ExperimentRun>(`/api/experiments/runs/${runId}/cancel`, {
    method: 'POST',
  });
}
