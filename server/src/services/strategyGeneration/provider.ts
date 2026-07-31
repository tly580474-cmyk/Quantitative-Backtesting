import type { StrategyRepairAudit } from './repairMiddleware.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StrategyDocument = Record<string, any>;

export interface GenerateStrategyRequest {
  prompt: string;
  model?: string;
  datasetContext?: {
    timeframe: string;
    availableFields: string[];
  };
  dslVersion: string;
}

export interface RefineStrategyRequest {
  currentStrategy: StrategyDocument;
  modification: string;
  model?: string;
  dslVersion: string;
}

export interface ExplainStrategyRequest {
  strategy: StrategyDocument;
}

export interface GenerateStrategyResult {
  generationId: string;
  strategy: StrategyDocument;
  summary: string;
  warnings: string[];
  requiresConfirmation: boolean;
  repairAudit?: StrategyRepairAudit;
}

export interface StrategyExplanation {
  explanation: string;
  risks: string[];
  parameterNotes: string;
}

export interface AIStatus {
  enabled: boolean;
  configured: boolean;
  provider: string;
}

export interface StrategyGenerationProvider {
  generate(request: GenerateStrategyRequest): Promise<GenerateStrategyResult>;
  refine(request: RefineStrategyRequest): Promise<GenerateStrategyResult>;
  explain(request: ExplainStrategyRequest): Promise<StrategyExplanation>;
}
