import { runBacktest } from '@/features/backtest/engine';
import { getStrategyById } from '@/features/strategies/registry';
import type { WorkerRequest, WorkerResponse } from './protocol';

let cancelled = false;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (msg.type === 'run') {
    cancelled = false;
    const { taskId, candles, strategyId, strategyParams, config, datasetId, datasetChecksum, resultName } = msg;

    try {
      const strategy = getStrategyById(strategyId);
      if (!strategy) {
        const response: WorkerResponse = {
          type: 'error',
          taskId,
          error: `未找到策略: ${strategyId}`,
        };
        self.postMessage(response);
        return;
      }

      const result = runBacktest(
        {
          candles,
          strategy,
          strategyParams,
          config,
          datasetId,
          datasetChecksum,
          resultName,
        },
        (progress) => {
          if (cancelled) return;
          const response: WorkerResponse = {
            type: 'progress',
            taskId,
            ...progress,
          };
          self.postMessage(response);
        },
      );

      if (cancelled) {
        const response: WorkerResponse = { type: 'cancelled', taskId };
        self.postMessage(response);
        return;
      }

      const response: WorkerResponse = { type: 'result', taskId, result };
      self.postMessage(response);
    } catch (err) {
      const response: WorkerResponse = {
        type: 'error',
        taskId,
        error: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
  }
};
