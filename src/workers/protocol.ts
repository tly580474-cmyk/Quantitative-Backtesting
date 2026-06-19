import type { Candle, BacktestConfig, BacktestResult } from '@/models';
import type { VisualStrategyDocument, StrategySignalWithTrace } from '@/features/visualStrategies/types';

export type StrategySource = 'builtin' | 'visual';

export interface RunBacktestRequest {
  type: 'run';
  taskId: string;
  candles: Candle[];
  strategySource: StrategySource;
  strategyId: string;
  strategyParams: Record<string, number | boolean | string>;
  /** Visual strategy DSL — required when strategySource is 'visual' */
  strategyDocument?: VisualStrategyDocument;
  config: BacktestConfig;
  datasetId: string;
  datasetName?: string;
  datasetChecksum: string;
  resultName: string;
}

export interface CancelRequest {
  type: 'cancel';
  taskId: string;
}

export interface PreviewStrategyRequest {
  type: 'preview';
  taskId: string;
  candles: Candle[];
  document: VisualStrategyDocument;
  params: Record<string, number | boolean | string>;
}

export type WorkerRequest = RunBacktestRequest | CancelRequest | PreviewStrategyRequest;

export interface ProgressResponse {
  type: 'progress';
  taskId: string;
  current: number;
  total: number;
  message: string;
}

export interface ResultResponse {
  type: 'result';
  taskId: string;
  result: BacktestResult;
}

export interface ErrorResponse {
  type: 'error';
  taskId: string;
  error: string;
}

export interface CancelledResponse {
  type: 'cancelled';
  taskId: string;
}

export interface PreviewResponse {
  type: 'previewResult';
  taskId: string;
  signals: StrategySignalWithTrace[];
}

export type WorkerResponse =
  | ProgressResponse
  | ResultResponse
  | ErrorResponse
  | CancelledResponse
  | PreviewResponse;
