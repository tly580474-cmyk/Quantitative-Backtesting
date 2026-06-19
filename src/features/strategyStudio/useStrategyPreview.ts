import { useRef, useState, useCallback } from 'react';
import type { Candle } from '@/models';
import type { VisualStrategyDocument, StrategySignalWithTrace } from '@/features/visualStrategies/types';
import type { WorkerRequest, WorkerResponse } from '@/workers/protocol';

export type PreviewStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export function useStrategyPreview() {
  const workerRef = useRef<Worker | null>(null);
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [signals, setSignals] = useState<StrategySignalWithTrace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const taskIdRef = useRef('');

  const run = useCallback(
    (candles: Candle[], document: VisualStrategyDocument, params: Record<string, number | boolean | string> = {}) => {
      if (workerRef.current) workerRef.current.terminate();

      setStatus('running');
      setProgress({ current: 0, total: candles.length });
      setSignals([]);
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
            setProgress({ current: msg.current, total: msg.total });
            break;
          case 'previewResult':
            setStatus('completed');
            setSignals(msg.signals);
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
        type: 'preview',
        taskId,
        candles,
        document,
        params,
      };
      worker.postMessage(request);
    },
    [],
  );

  const cancel = useCallback(() => {
    if (workerRef.current && taskIdRef.current) {
      workerRef.current.postMessage({ type: 'cancel', taskId: taskIdRef.current });
    }
  }, []);

  return { run, cancel, status, progress, signals, error };
}
