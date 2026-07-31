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
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface CreateExperimentRunRequest {
  experimentVersionId: string;
  idempotencyKey: string;
  engineVersion: string;
  datasetSnapshot: BacktestResult['datasetSnapshot'];
  config: BacktestConfig;
  strategyParams: Record<string, number | boolean | string>;
}
