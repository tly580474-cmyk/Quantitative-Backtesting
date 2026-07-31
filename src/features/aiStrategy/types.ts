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
  confirmation: StrategyConfirmationDraft;
  repairAudit?: StrategyRepairAudit;
}

export interface StrategyConfirmationField {
  key: string;
  label: string;
  value: string;
  evidencePath: string;
}

export interface StrategyConfirmationAssumption {
  id: string;
  label: string;
  selectedValue: string;
  options: string[];
  reason: string;
  required: boolean;
}

export interface StrategyConfirmationDraft {
  sourceText: string;
  extractedFields: StrategyConfirmationField[];
  assumptions: StrategyConfirmationAssumption[];
}

export interface StrategyRepairAudit {
  version: 1;
  originalCandidate: unknown;
  beforeHash: string;
  afterHash: string;
  changed: boolean;
  operations: Array<{
    path: Array<string | number>;
    kind: string;
    before: unknown;
    after: unknown;
  }>;
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
