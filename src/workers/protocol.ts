import type { Candle, BacktestConfig, BacktestResult } from '@/models';

export interface RunBacktestRequest {
  type: 'run';
  taskId: string;
  candles: Candle[];
  strategyId: string;
  strategyParams: Record<string, number | boolean | string>;
  config: BacktestConfig;
  datasetId: string;
  datasetChecksum: string;
  resultName: string;
}

export interface CancelRequest {
  type: 'cancel';
  taskId: string;
}

export type WorkerRequest = RunBacktestRequest | CancelRequest;

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

export type WorkerResponse =
  | ProgressResponse
  | ResultResponse
  | ErrorResponse
  | CancelledResponse;
