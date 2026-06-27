import { runBacktestAsync } from '@/features/backtest/engine';
import { getStrategyById } from '@/features/strategies/registry';
import { compileAndValidate } from '@/features/visualStrategies/compiler';
import { validateDocument } from '@/features/visualStrategies/validator';
import type { VisualStrategyDocument } from '@/features/visualStrategies/types';
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
    const {
      taskId, candles, strategySource, strategyId,
      strategyParams, config, datasetId, datasetName, datasetChecksum, resultName,
    } = msg;

    let strategy;

    if (config.backtestMode === 'dca') {
      // DCA is strategy-independent and buys directly on scheduled closes.
      strategy = undefined;
    } else if (strategySource === 'visual') {
      if (!msg.strategyDocument) {
        const response: WorkerResponse = {
          type: 'error', taskId,
          error: '缺少视觉策略 DSL 文档',
        };
        self.postMessage(response);
        return;
      }

      // Re-validate and compile DSL in worker (don't trust main thread)
      const result = compileAndValidate(msg.strategyDocument);
      if (!result.success) {
        const response: WorkerResponse = {
          type: 'error', taskId,
          error: `策略校验失败: ${result.errors.join('; ')}`,
        };
        self.postMessage(response);
        return;
      }
      strategy = result.strategy;
    } else {
      strategy = getStrategyById(strategyId);
      if (!strategy) {
        const response: WorkerResponse = {
          type: 'error', taskId,
          error: `未找到策略: ${strategyId}`,
        };
        self.postMessage(response);
        return;
      }
    }

    // Use async engine so cancel messages can be processed between chunks
    runBacktestAsync(
      { candles, strategy, strategyParams, config, datasetId, datasetName, datasetChecksum, resultName },
      (progress) => {
        if (cancelled) return;
        self.postMessage({ type: 'progress', taskId, ...progress } as WorkerResponse);
      },
      () => cancelled,
    ).then((result) => {
      if (cancelled || result.status === 'cancelled') {
        self.postMessage({ type: 'cancelled', taskId } as WorkerResponse);
        return;
      }
      self.postMessage({ type: 'result', taskId, result } as WorkerResponse);
    }).catch((err) => {
      self.postMessage({
        type: 'error', taskId,
        error: err instanceof Error ? err.message : String(err),
      } as WorkerResponse);
    });
  }

  if (msg.type === 'preview') {
    cancelled = false;
    const { taskId, candles, document, params } = msg;

    // Re-validate and compile in worker
    const result = compileAndValidate(document);
    if (!result.success) {
      self.postMessage({
        type: 'error', taskId,
        error: `策略校验失败: ${result.errors.join('; ')}`,
      } as WorkerResponse);
      return;
    }

    const strategy = result.strategy;
    const signals: import('@/features/visualStrategies/types').StrategySignalWithTrace[] = [];

    // Simulate percentage-based step-in/step-out position changes so repeated
    // studio signals remain visible in preview.
    let posQuantity = 0;
    let posAvgCost = 0;
    let posEntryTime: string | undefined;
    let previewCash = 100_000;
    const previewTradePercent = 0.25;

    for (let i = 0; i < candles.length; i++) {
      if (i > 0 && i % 200 === 0) {
        if (cancelled) {
          self.postMessage({ type: 'cancelled', taskId } as WorkerResponse);
          return;
        }
      }

      const ctx = {
        index: i,
        candles: candles.slice(0, i + 1),
        indicators: {},
        position: {
          quantity: posQuantity,
          avgCost: posAvgCost,
          entryTime: posEntryTime,
        },
      };

      const signal = strategy.evaluate(ctx, params);

      // Simulate position changes from signals (simplified — no slippage/commission)
      if (signal.action === 'buy' && previewCash > 0 && i < candles.length - 1) {
        const fillPrice = candles[i + 1].open;
        const spend = previewCash * previewTradePercent;
        const addedQuantity = spend / fillPrice;
        const totalCost = posAvgCost * posQuantity + spend;
        posQuantity += addedQuantity;
        previewCash -= spend;
        posAvgCost = totalCost / posQuantity;
        posEntryTime ??= candles[i + 1].time;
      } else if (signal.action === 'sell' && posQuantity > 0 && i < candles.length - 1) {
        const fillPrice = candles[i + 1].open;
        const partialQuantity = posQuantity * previewTradePercent;
        const remainingMarketValue = (posQuantity - partialQuantity) * fillPrice;
        const soldQuantity = remainingMarketValue < 1 ? posQuantity : partialQuantity;
        posQuantity -= soldQuantity;
        previewCash += soldQuantity * fillPrice;
        if (posQuantity === 0) {
          posQuantity = 0;
          posAvgCost = 0;
          posEntryTime = undefined;
        }
      }

      signals.push({
        time: signal.time,
        action: signal.action,
        reason: signal.reason,
        strength: signal.strength,
      });
    }

    self.postMessage({
      type: 'previewResult',
      taskId,
      signals,
    } as WorkerResponse);
  }
};
