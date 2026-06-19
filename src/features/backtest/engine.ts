import type {
  Candle,
  BacktestConfig,
  BacktestResult,
  BacktestMetrics,
  Order,
  Trade,
  StrategySignal,
  EquityPoint,
  StrategyDefinition,
} from '@/models';
import type { PositionSnapshot } from '@/models';
import { fillOrder } from './broker';
import {
  createPortfolio,
  applyTrade,
  createEquityPoint,
  type PortfolioState,
} from './portfolio';
import { calculateMetrics } from './metrics';
import { validateBacktestInput } from './validation';

export interface BacktestInput {
  candles: Candle[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strategy: StrategyDefinition<any>;
  strategyParams: Record<string, number | boolean | string>;
  config: BacktestConfig;
  datasetId: string;
  datasetChecksum: string;
  resultName: string;
}

export interface BacktestProgress {
  current: number;
  total: number;
  message: string;
}

/** Number of bars to process before yielding to the event loop. */
const YIELD_EVERY = 200;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Async backtest engine. Periodically yields to the event loop so
 * Web Worker cancellation messages can be processed between chunks.
 */
export async function runBacktestAsync(
  input: BacktestInput,
  onProgress?: (progress: BacktestProgress) => void,
  isCancelled?: () => boolean,
): Promise<BacktestResult> {
  const { candles, strategy, strategyParams, config, datasetId, datasetChecksum, resultName } = input;
  const totalBars = candles.length;

  // Pre-flight validation
  const errors = validateBacktestInput(candles, config);
  if (errors.length > 0) {
    return createFailedResult(input, errors.map((e) => e.message).join('; '));
  }

  const portfolio: PortfolioState = createPortfolio(config.initialCapital);
  const signals: StrategySignal[] = [];
  const orders: Order[] = [];
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  let peakEquity = config.initialCapital;

  let pendingOrder: Order | null = null;

  for (let i = 0; i < totalBars; i++) {
    // Yield every N bars so the event loop can process cancel messages
    if (i > 0 && i % YIELD_EVERY === 0) {
      if (isCancelled?.()) {
        return createCancelledResult(input);
      }
      await yieldToEventLoop();
    }

    const candle = candles[i];

    // --- Step 1: Execute pending order at today's open ---
    if (pendingOrder) {
      const execTime = candle.time;
      const orderWithTime = { ...pendingOrder, executeTime: execTime };

      const result = fillOrder(
        orderWithTime,
        candle.open,
        portfolio.cash,
        portfolio.positionQuantity,
        config,
      );

      if (result.trade.quantity > 0) {
        Object.assign(portfolio, applyTrade(portfolio, result.trade));
        trades.push(result.trade);
        orderWithTime.status = 'filled';
        orders.push(orderWithTime);
      } else {
        orderWithTime.status = 'rejected';
        orderWithTime.rejectReason = result.error;
        orders.push(orderWithTime);
        trades.push(result.trade);
      }

      pendingOrder = null;
    }

    // --- Step 2: Generate signal ---
    const position: PositionSnapshot = {
      quantity: portfolio.positionQuantity,
      avgCost: portfolio.avgCost,
      entryTime: portfolio.entryTime ?? undefined,
    };

    const slicedCandles = candles.slice(0, i + 1);
    const indicators: Record<string, readonly (number | null)[]> = {};

    const context = {
      index: i,
      candles: slicedCandles,
      indicators,
      position,
    };

    const signal = strategy.evaluate(context, strategyParams);
    signals.push(signal);

    // --- Step 3: Create order from signal ---
    if (signal.action !== 'hold' && i < totalBars - 1) {
      const nextCandle = candles[i + 1];

      if (signal.action === 'buy') {
        if (portfolio.positionQuantity === 0) {
          const slippageFactor = config.slippageBps / 10000;
          const estimatedFillPrice = nextCandle.open * (1 + slippageFactor);
          const maxSpend = portfolio.cash * config.positionSizing.value;
          const estimatedAmount = Math.floor(
            maxSpend / config.minimumTradeAmount,
          ) * config.minimumTradeAmount;
          const estimatedQty = estimatedAmount / estimatedFillPrice;

          if (estimatedAmount >= config.minimumTradeAmount) {
            pendingOrder = {
              id: crypto.randomUUID(),
              signalTime: signal.time,
              executeTime: '',
              side: 'buy',
              orderType: 'market',
              quantity: estimatedQty,
              status: 'pending',
            };
          } else {
            orders.push({
              id: crypto.randomUUID(),
              signalTime: signal.time,
              executeTime: nextCandle.time,
              side: 'buy',
              orderType: 'market',
              quantity: estimatedQty,
              status: 'rejected',
              rejectReason: '现金不足',
            });
          }
        } else {
          orders.push({
            id: crypto.randomUUID(),
            signalTime: signal.time,
            executeTime: nextCandle.time,
            side: 'buy',
            orderType: 'market',
            quantity: 0,
            status: 'cancelled',
            rejectReason: '已有持仓',
          });
        }
      } else if (signal.action === 'sell') {
        if (portfolio.positionQuantity > 0) {
          pendingOrder = {
            id: crypto.randomUUID(),
            signalTime: signal.time,
            executeTime: '',
            side: 'sell',
            orderType: 'market',
            quantity: portfolio.positionQuantity,
            status: 'pending',
          };
        } else {
          orders.push({
            id: crypto.randomUUID(),
            signalTime: signal.time,
            executeTime: nextCandle.time,
            side: 'sell',
            orderType: 'market',
            quantity: 0,
            status: 'cancelled',
            rejectReason: '无持仓',
          });
        }
      }
    } else if (signal.action !== 'hold' && i === totalBars - 1) {
      signals[signals.length - 1] = {
        ...signal,
        action: 'hold',
        reason: '最后一根 K 线信号取消',
      };
    }

    // --- Step 4: Daily equity snapshot ---
    const point = createEquityPoint(candle.time, portfolio, candle.close, peakEquity);
    if (point.equity > peakEquity) {
      peakEquity = point.equity;
    }
    equityCurve.push(point);

    // --- Step 5: Force close at end ---
    if (i === totalBars - 1 && config.forceCloseAtEnd && portfolio.positionQuantity > 0) {
      if (pendingOrder) {
        pendingOrder = null;
      }

      const forceCloseTrade: Trade = {
        id: crypto.randomUUID(),
        orderId: 'force-close',
        time: candle.time,
        side: 'sell',
        quantity: portfolio.positionQuantity,
        rawPrice: candle.close,
        fillPrice: candle.close,
        commission: Math.max(
          portfolio.positionQuantity * candle.close * config.commissionRate,
          config.minimumCommission,
        ),
        tax: portfolio.positionQuantity * candle.close * config.sellTaxRate,
        slippageCost: 0,
        amount: portfolio.positionQuantity * candle.close,
        forceClose: true,
      };

      Object.assign(portfolio, applyTrade(portfolio, forceCloseTrade));
      trades.push(forceCloseTrade);

      const forceCloseOrder: Order = {
        id: 'force-close',
        signalTime: candle.time,
        executeTime: candle.time,
        side: 'sell',
        orderType: 'market',
        quantity: forceCloseTrade.quantity,
        status: 'filled',
      };
      orders.push(forceCloseOrder);

      const finalPoint = createEquityPoint(candle.time, portfolio, candle.close, peakEquity);
      equityCurve[equityCurve.length - 1] = finalPoint;
    }

    onProgress?.({
      current: i + 1,
      total: totalBars,
      message: `回测中... ${i + 1}/${totalBars}`,
    });
  }

  const metrics = calculateMetrics(equityCurve, trades, config.initialCapital);

  if (candles.length > 0) {
    const firstClose = candles[0].close;
    const lastClose = candles[candles.length - 1].close;
    if (firstClose > 0) {
      metrics.benchmarkReturn = (lastClose - firstClose) / firstClose;
      metrics.excessReturn = metrics.totalReturn - metrics.benchmarkReturn;
    }
  }

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: resultName,
    status: 'completed',
    datasetSnapshot: {
      id: datasetId,
      symbol: candles[0]?.symbol ?? '',
      startTime: candles[0]?.time ?? '',
      endTime: candles[candles.length - 1]?.time ?? '',
      checksum: datasetChecksum,
    },
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    strategyParams,
    config,
    startedAt: now,
    completedAt: now,
    metrics,
    signals,
    trades,
    equityCurve,
  };
}

/**
 * Synchronous backtest — thin wrapper for tests and callers that
 * don't need event-loop yielding.
 */
export function runBacktest(
  input: BacktestInput,
  onProgress?: (progress: BacktestProgress) => void,
): BacktestResult {
  const { candles, strategy, strategyParams, config, datasetId, datasetChecksum, resultName } = input;
  const totalBars = candles.length;

  const errors = validateBacktestInput(candles, config);
  if (errors.length > 0) {
    return createFailedResult(input, errors.map((e) => e.message).join('; '));
  }

  const portfolio: PortfolioState = createPortfolio(config.initialCapital);
  const signals: StrategySignal[] = [];
  const orders: Order[] = [];
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  let peakEquity = config.initialCapital;

  let pendingOrder: Order | null = null;

  for (let i = 0; i < totalBars; i++) {
    const candle = candles[i];

    if (pendingOrder) {
      const execTime = candle.time;
      const orderWithTime = { ...pendingOrder, executeTime: execTime };

      const result = fillOrder(
        orderWithTime,
        candle.open,
        portfolio.cash,
        portfolio.positionQuantity,
        config,
      );

      if (result.trade.quantity > 0) {
        Object.assign(portfolio, applyTrade(portfolio, result.trade));
        trades.push(result.trade);
        orderWithTime.status = 'filled';
        orders.push(orderWithTime);
      } else {
        orderWithTime.status = 'rejected';
        orderWithTime.rejectReason = result.error;
        orders.push(orderWithTime);
        trades.push(result.trade);
      }

      pendingOrder = null;
    }

    const position: PositionSnapshot = {
      quantity: portfolio.positionQuantity,
      avgCost: portfolio.avgCost,
      entryTime: portfolio.entryTime ?? undefined,
    };

    const slicedCandles = candles.slice(0, i + 1);
    const indicators: Record<string, readonly (number | null)[]> = {};

    const context = {
      index: i,
      candles: slicedCandles,
      indicators,
      position,
    };

    const signal = strategy.evaluate(context, strategyParams);
    signals.push(signal);

    if (signal.action !== 'hold' && i < totalBars - 1) {
      const nextCandle = candles[i + 1];

      if (signal.action === 'buy') {
        if (portfolio.positionQuantity === 0) {
          const slippageFactor = config.slippageBps / 10000;
          const estimatedFillPrice = nextCandle.open * (1 + slippageFactor);
          const maxSpend = portfolio.cash * config.positionSizing.value;
          const estimatedAmount = Math.floor(
            maxSpend / config.minimumTradeAmount,
          ) * config.minimumTradeAmount;
          const estimatedQty = estimatedAmount / estimatedFillPrice;

          if (estimatedAmount >= config.minimumTradeAmount) {
            pendingOrder = {
              id: crypto.randomUUID(),
              signalTime: signal.time,
              executeTime: '',
              side: 'buy',
              orderType: 'market',
              quantity: estimatedQty,
              status: 'pending',
            };
          } else {
            orders.push({
              id: crypto.randomUUID(),
              signalTime: signal.time,
              executeTime: nextCandle.time,
              side: 'buy',
              orderType: 'market',
              quantity: estimatedQty,
              status: 'rejected',
              rejectReason: '现金不足',
            });
          }
        } else {
          orders.push({
            id: crypto.randomUUID(),
            signalTime: signal.time,
            executeTime: nextCandle.time,
            side: 'buy',
            orderType: 'market',
            quantity: 0,
            status: 'cancelled',
            rejectReason: '已有持仓',
          });
        }
      } else if (signal.action === 'sell') {
        if (portfolio.positionQuantity > 0) {
          pendingOrder = {
            id: crypto.randomUUID(),
            signalTime: signal.time,
            executeTime: '',
            side: 'sell',
            orderType: 'market',
            quantity: portfolio.positionQuantity,
            status: 'pending',
          };
        } else {
          orders.push({
            id: crypto.randomUUID(),
            signalTime: signal.time,
            executeTime: nextCandle.time,
            side: 'sell',
            orderType: 'market',
            quantity: 0,
            status: 'cancelled',
            rejectReason: '无持仓',
          });
        }
      }
    } else if (signal.action !== 'hold' && i === totalBars - 1) {
      signals[signals.length - 1] = {
        ...signal,
        action: 'hold',
        reason: '最后一根 K 线信号取消',
      };
    }

    const point = createEquityPoint(candle.time, portfolio, candle.close, peakEquity);
    if (point.equity > peakEquity) {
      peakEquity = point.equity;
    }
    equityCurve.push(point);

    if (i === totalBars - 1 && config.forceCloseAtEnd && portfolio.positionQuantity > 0) {
      if (pendingOrder) {
        pendingOrder = null;
      }

      const forceCloseTrade: Trade = {
        id: crypto.randomUUID(),
        orderId: 'force-close',
        time: candle.time,
        side: 'sell',
        quantity: portfolio.positionQuantity,
        rawPrice: candle.close,
        fillPrice: candle.close,
        commission: Math.max(
          portfolio.positionQuantity * candle.close * config.commissionRate,
          config.minimumCommission,
        ),
        tax: portfolio.positionQuantity * candle.close * config.sellTaxRate,
        slippageCost: 0,
        amount: portfolio.positionQuantity * candle.close,
        forceClose: true,
      };

      Object.assign(portfolio, applyTrade(portfolio, forceCloseTrade));
      trades.push(forceCloseTrade);

      const forceCloseOrder: Order = {
        id: 'force-close',
        signalTime: candle.time,
        executeTime: candle.time,
        side: 'sell',
        orderType: 'market',
        quantity: forceCloseTrade.quantity,
        status: 'filled',
      };
      orders.push(forceCloseOrder);

      const finalPoint = createEquityPoint(candle.time, portfolio, candle.close, peakEquity);
      equityCurve[equityCurve.length - 1] = finalPoint;
    }

    onProgress?.({
      current: i + 1,
      total: totalBars,
      message: `回测中... ${i + 1}/${totalBars}`,
    });
  }

  const metrics = calculateMetrics(equityCurve, trades, config.initialCapital);

  if (candles.length > 0) {
    const firstClose = candles[0].close;
    const lastClose = candles[candles.length - 1].close;
    if (firstClose > 0) {
      metrics.benchmarkReturn = (lastClose - firstClose) / firstClose;
      metrics.excessReturn = metrics.totalReturn - metrics.benchmarkReturn;
    }
  }

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: resultName,
    status: 'completed',
    datasetSnapshot: {
      id: datasetId,
      symbol: candles[0]?.symbol ?? '',
      startTime: candles[0]?.time ?? '',
      endTime: candles[candles.length - 1]?.time ?? '',
      checksum: datasetChecksum,
    },
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    strategyParams,
    config,
    startedAt: now,
    completedAt: now,
    metrics,
    signals,
    trades,
    equityCurve,
  };
}

function createCancelledResult(input: BacktestInput): BacktestResult {
  const now = new Date().toISOString();
  const { candles, strategy, strategyParams, config, datasetId, datasetChecksum, resultName } = input;
  return {
    id: crypto.randomUUID(),
    name: resultName,
    status: 'cancelled',
    datasetSnapshot: {
      id: datasetId,
      symbol: candles[0]?.symbol ?? '',
      startTime: candles[0]?.time ?? '',
      endTime: candles.length > 0 ? candles[candles.length - 1].time : '',
      checksum: datasetChecksum,
    },
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    strategyParams,
    config,
    startedAt: now,
    completedAt: now,
    metrics: createZeroMetrics(config.initialCapital),
    signals: [],
    trades: [],
    equityCurve: [],
  };
}

function createFailedResult(input: BacktestInput, error: string): BacktestResult {
  const now = new Date().toISOString();
  const { candles, strategy, strategyParams, config, datasetId, datasetChecksum, resultName } = input;
  return {
    id: crypto.randomUUID(),
    name: resultName,
    status: 'failed',
    datasetSnapshot: {
      id: datasetId,
      symbol: candles[0]?.symbol ?? '',
      startTime: candles[0]?.time ?? '',
      endTime: candles.length > 0 ? candles[candles.length - 1].time : '',
      checksum: datasetChecksum,
    },
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    strategyParams,
    config,
    startedAt: now,
    completedAt: now,
    metrics: createZeroMetrics(config.initialCapital),
    signals: [],
    trades: [],
    equityCurve: [],
    error,
  };
}

function createZeroMetrics(initialCapital: number): BacktestMetrics {
  return {
    initialCapital,
    finalEquity: initialCapital,
    totalReturn: 0,
    annualizedReturn: 0,
    annualizedVolatility: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    maxDrawdownStart: '',
    maxDrawdownEnd: '',
    tradeCount: 0,
    winRate: 0,
    profitFactor: 0,
    avgHoldingDays: 0,
    totalCommission: 0,
    totalTax: 0,
    totalSlippage: 0,
    benchmarkReturn: 0,
    excessReturn: 0,
  };
}
