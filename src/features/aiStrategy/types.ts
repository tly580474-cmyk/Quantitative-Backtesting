import type { VisualStrategyDocument } from '@/features/visualStrategies/types';

export interface AIStatus {
  enabled: boolean;
  configured: boolean;
  provider: string;
  currentModel: string;
  availableModels: string[];
}

export interface GenerateStrategyRequest {
  prompt: string;
  model?: string;
  datasetContext?: {
    timeframe: string;
    availableFields: string[];
  };
  dslVersion: string;
}

export interface GenerateStrategyResult {
  generationId: string;
  strategy: VisualStrategyDocument;
  summary: string;
  warnings: string[];
  requiresConfirmation: boolean;
}

export interface RefineStrategyRequest {
  currentStrategy: VisualStrategyDocument;
  modification: string;
  model?: string;
  dslVersion: string;
}

export interface ExplainStrategyRequest {
  strategy: VisualStrategyDocument;
}

export interface StrategyExplanation {
  explanation: string;
  risks: string[];
  parameterNotes: string;
}
