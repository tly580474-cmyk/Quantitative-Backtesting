import { useRef, useState, useCallback } from 'react';
import type { BacktestResult, Candle, BacktestConfig } from '@/models';
import type { VisualStrategyDocument } from '@/features/visualStrategies/types';
import type { WorkerRequest, WorkerResponse, StrategySource } from '@/workers/protocol';

export interface BacktestProgress {
  current: number;
  total: number;
  message: string;
}

export type BacktestStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export function useBacktest() {
  const workerRef = useRef<Worker | null>(null);
  const [status, setStatus] = useState<BacktestStatus>('idle');
  const [progress, setProgress] = useState<BacktestProgress | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taskIdRef = useRef<string>('');

  const run = useCallback(
    (
      candles: Candle[],
      strategyId: string,
      strategyParams: Record<string, number | boolean | string>,
      config: BacktestConfig,
      datasetId: string,
      datasetName: string,
      datasetChecksum: string,
      resultName: string,
      options?: {
        strategySource?: StrategySource;
        strategyDocument?: VisualStrategyDocument;
      },
    ) => {
      // Clean up previous worker
      if (workerRef.current) {
        workerRef.current.terminate();
      }

      setStatus('running');
      setProgress({ current: 0, total: candles.length, message: '初始化...' });
      setResult(null);
      setError(null);

      const taskId = crypto.randomUUID();
      taskIdRef.current = taskId;

      const worker = new Worker(
        new URL('@/workers/backtest.worker.ts', import.meta.url),
        { type: 'module' },
      );

      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.taskId !== taskId) return;

        switch (msg.type) {
          case 'progress':
            setProgress({ current: msg.current, total: msg.total, message: msg.message });
            break;
          case 'result':
            setStatus('completed');
            setResult(msg.result);
            worker.terminate();
            workerRef.current = null;
            break;
          case 'error':
            setStatus('failed');
            setError(msg.error);
            worker.terminate();
            workerRef.current = null;
            break;
          case 'cancelled':
            setStatus('cancelled');
            worker.terminate();
            workerRef.current = null;
            break;
        }
      };

      worker.onerror = (err) => {
        setStatus('failed');
        setError(err.message);
        worker.terminate();
        workerRef.current = null;
      };

      const request: WorkerRequest = {
        type: 'run',
        taskId,
        candles,
        strategySource: options?.strategySource ?? 'builtin',
        strategyId,
        strategyDocument: options?.strategyDocument,
        strategyParams,
        config,
        datasetId,
        datasetName,
        datasetChecksum,
        resultName,
      };

      worker.postMessage(request);
    },
    [],
  );

  const cancel = useCallback(() => {
    if (workerRef.current && taskIdRef.current) {
      const request: WorkerRequest = {
        type: 'cancel',
        taskId: taskIdRef.current,
      };
      workerRef.current.postMessage(request);
    }
  }, []);

  return { run, cancel, status, progress, result, error };
}
