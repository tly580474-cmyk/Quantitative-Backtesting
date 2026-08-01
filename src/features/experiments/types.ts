import type { BacktestConfig, BacktestResult } from '@/models';
import type { VisualStrategyDocument } from '@/features/visualStrategies/types';
import type { StrategyConfirmationDraft } from '@/features/aiStrategy/types';

export interface ConfirmExperimentRequest {
  generationId?: string;
  experimentId?: string;
  name: string;
  sourceText: string;
  strategy: VisualStrategyDocument;
  confirmation: StrategyConfirmationDraft & {
    assumptions: Array<StrategyConfirmationDraft['assumptions'][number] & {
      confirmed: boolean;
    }>;
  };
  capabilityVersion: string;
}

export interface ExperimentVersion {
  id: string;
  experimentId: string;
  version: number;
  status: 'frozen';
  specHash: string;
  capabilityVersion: string;
  compilerVersion: string;
  createdAt: string;
}

export interface ExperimentRun {
  id: string;
  experimentVersionId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  inputHash: string;
  backtestResultId?: string | null;
  resultHash?: string | null;
  validationStatus?: 'pending' | 'candidate' | 'rejected' | null;
  validationPolicyVersion?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface ValidationCheck {
  id: string;
  category: 'data' | 'causality' | 'sample' | 'risk' | 'trading' | 'robustness' | 'governance';
  status: 'passed' | 'failed' | 'pending';
  message: string;
  sourcePath: string;
  value?: unknown;
  threshold?: unknown;
}

export interface ExperimentReport {
  id: string;
  runId: string;
  templateVersion: string;
  structuredReport: {
    validation: { status: 'pending' | 'candidate' | 'rejected'; policyVersion: string; checks: ValidationCheck[] };
    evidence: { resultHash: string; evaluationHash: string; calculatorVersion: string };
  };
  markdown: string;
  reportHash: string;
  createdAt: string;
}

export interface ExperimentArtifactJob {
  id: string;
  reportId: string;
  format: 'html' | 'pdf';
  status: 'queued' | 'running' | 'completed' | 'failed';
  artifactUri?: string | null;
  errorMessage?: string | null;
  expiresAt: string;
}

export interface ExperimentValidationPlan {
  lockedTestStatus: 'sealed' | 'opened';
  lockedTestOpenedAt?: string | null;
  samplePlan: {
    ranges: Array<{
      kind: 'train' | 'validation' | 'locked_test';
      startIndex: number;
      endIndex: number;
      startTime: string;
      endTime: string;
    }>;
    walkForward: Array<{
      fold: number;
      validation: { startIndex: number; endIndex: number; startTime: string; endTime: string };
    }>;
  };
}

export interface CreateExperimentRunRequest {
  experimentVersionId: string;
  idempotencyKey: string;
  engineVersion: string;
  datasetSnapshot: BacktestResult['datasetSnapshot'];
  config: BacktestConfig;
  strategyParams: Record<string, number | boolean | string>;
}
