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
  applyCashContribution,
  createEquityPoint,
  type PortfolioState,
} from './portfolio';
import { calculateMetrics } from './metrics';
import { validateBacktestInput } from './validation';

export interface BacktestInput {
  candles: Candle[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strategy?: StrategyDefinition<any>;
  strategyParams: Record<string, number | boolean | string>;
  config: BacktestConfig;
  datasetId: string;
  datasetName?: string;
  datasetChecksum: string;
  resultName: string;
}

export interface BacktestProgress {
  current: number;
  total: number;
  message: string;
}

const YIELD_EVERY = 200;

// ─── Bar-level mutable state ───────────────────────────────────────

interface BacktestState {
  portfolio: PortfolioState;
  signals: StrategySignal[];
  orders: Order[];
  trades: Trade[];
  equityCurve: EquityPoint[];
  peakEquity: number;
  pendingOrder: Order | null;
  currentPositionPnl: number;
  consecutiveLosingTrades: number;
  lastCompletedTradeTime: string | null;
}

function applyStrategyTrade(state: BacktestState, trade: Trade): void {
  const positionBefore = state.portfolio.positionQuantity;
  const avgCostBefore = state.portfolio.avgCost;

  if (trade.side === 'buy') {
    state.currentPositionPnl -= trade.commission;
  } else {
    state.currentPositionPnl +=
      (trade.fillPrice - avgCostBefore) * trade.quantity - trade.commission - trade.tax;
  }

  Object.assign(state.portfolio, applyTrade(state.portfolio, trade));

  if (trade.side === 'sell' && positionBefore > 0 && state.portfolio.positionQuantity === 0) {
    state.consecutiveLosingTrades = state.currentPositionPnl < 0
      ? state.consecutiveLosingTrades + 1
      : 0;
    state.lastCompletedTradeTime = trade.time;
    state.currentPositionPnl = 0;
  }
}

// ─── DCA helpers ───────────────────────────────────────────────────

function isDcaDue(candles: Candle[], index: number, frequency: BacktestConfig['dca']['frequency']): boolean {
  if (frequency === 'daily' || index === 0) return true;
  const current = new Date(`${candles[index].time}T00:00:00`);
  const previous = new Date(`${candles[index - 1].time}T00:00:00`);
  if (frequency === 'monthly') {
    return current.getFullYear() !== previous.getFullYear() || current.getMonth() !== previous.getMonth();
  }
  const day = (date: Date) => (date.getDay() + 6) % 7;
  const currentMonday = new Date(current);
  currentMonday.setDate(current.getDate() - day(current));
  const previousMonday = new Date(previous);
  previousMonday.setDate(previous.getDate() - day(previous));
  return currentMonday.getTime() !== previousMonday.getTime();
}

function createDcaSignal(candles: Candle[], index: number, config: BacktestConfig): StrategySignal {
  const candle = candles[index];
  const due = isDcaDue(candles, index, config.dca.frequency);
  return {
    time: candle.time,
    action: due ? 'buy' : 'hold',
    reason: due ? `定投计划：${config.dca.frequency}投入 ¥${config.dca.amount}` : '等待下一个定投日',
  };
}

function createBuyOrder(
  signal: StrategySignal,
  nextCandle: Candle,
  cash: number,
  config: BacktestConfig,
): Order | null {
  const slippageFactor = config.slippageBps / 10000;
  const estimatedFillPrice = nextCandle.open * (1 + slippageFactor);
  const spendLimit = config.backtestMode === 'dca'
    ? Math.min(config.dca.amount, cash * config.positionSizing.value)
    : cash * config.positionSizing.value;
  const quantity = config.tradingUnitMode === 'stock'
    ? Math.floor(spendLimit / estimatedFillPrice / 100) * 100
    : Math.floor(spendLimit / (config.minimumTradeAmount ?? 1))
      * (config.minimumTradeAmount ?? 1) / estimatedFillPrice;
  if (quantity <= 0) return null;
  return {
    id: crypto.randomUUID(),
    signalTime: signal.time,
    executeTime: '',
    side: 'buy',
    orderType: 'market',
    quantity,
    status: 'pending',
  };
}

function createSellOrder(
  signal: StrategySignal,
  positionQuantity: number,
  estimatedFillPrice: number,
  config: BacktestConfig,
): Order | null {
  const requestedQuantity = positionQuantity * config.positionSizing.value;
  const partialQuantity = config.tradingUnitMode === 'stock'
    ? Math.max(100, Math.floor(requestedQuantity / 100) * 100)
    : requestedQuantity;
  const remainingQuantity = positionQuantity - partialQuantity;
  const remainingIsTradable = config.tradingUnitMode === 'stock'
    ? remainingQuantity >= 100
    : remainingQuantity * estimatedFillPrice >= (config.minimumTradeAmount ?? 1);
  // Avoid an asymptotic dust position: when the tail can no longer form one
  // effective trading unit, include it in the current sell order.
  const quantity = remainingIsTradable
    ? Math.min(partialQuantity, positionQuantity)
    : positionQuantity;
  if (quantity <= 0) return null;
  return {
    id: crypto.randomUUID(),
    signalTime: signal.time,
    executeTime: '',
    side: 'sell',
    orderType: 'market',
    quantity,
    status: 'pending',
  };
}

function createTargetPositionOrder(
  signal: StrategySignal,
  nextCandle: Candle,
  portfolio: PortfolioState,
  config: BacktestConfig,
): Order | null {
  const target = Math.max(0, Math.min(1, signal.targetPosition ?? 0));
  const equity = portfolio.cash + portfolio.positionQuantity * nextCandle.open;
  const currentValue = portfolio.positionQuantity * nextCandle.open;
  const desiredValue = equity * target;
  const valueDelta = desiredValue - currentValue;
  const minimumValue = config.tradingUnitMode === 'stock'
    ? nextCandle.open * 100
    : (config.minimumTradeAmount ?? 1);

  if (Math.abs(valueDelta) < minimumValue) return null;

  const side = valueDelta > 0 ? 'buy' : 'sell';
  const slippageFactor = config.slippageBps / 10000;
  const estimatedFillPrice = nextCandle.open * (
    side === 'buy' ? 1 + slippageFactor : 1 - slippageFactor
  );
  let quantity = Math.abs(valueDelta) / estimatedFillPrice;
  if (config.tradingUnitMode === 'stock') {
    quantity = Math.floor(quantity / 100) * 100;
  } else {
    const minimumTradeAmount = config.minimumTradeAmount ?? 1;
    const amount = Math.floor(
      quantity * estimatedFillPrice / minimumTradeAmount,
    ) * minimumTradeAmount;
    quantity = amount / estimatedFillPrice;
  }
  if (side === 'sell') quantity = Math.min(quantity, portfolio.positionQuantity);
  if (quantity <= 0) return null;

  return {
    id: crypto.randomUUID(),
    signalTime: signal.time,
    executeTime: '',
    side,
    orderType: 'market',
    quantity,
    status: 'pending',
    targetPosition: target,
  };
}

// DCA purchases execute at the same bar's close rather than T+1 open.
// The contribution is predetermined (not signal-driven), so there is no
// look-ahead concern. Strategy mode uses next-open to avoid peeking at the
// signal bar's close price before deciding.
function executeDcaPurchase(
  signal: StrategySignal,
  candle: Candle,
  portfolio: PortfolioState,
  config: BacktestConfig,
  orders: Order[],
  trades: Trade[],
  investmentAmount: number,
): void {
  Object.assign(
    portfolio,
    applyCashContribution(portfolio, investmentAmount),
  );

  const order: Order = {
    id: crypto.randomUUID(),
    signalTime: signal.time,
    executeTime: candle.time,
    side: 'buy',
    orderType: 'market',
    quantity: config.tradingUnitMode === 'stock'
      ? Math.floor(investmentAmount / candle.close / 100) * 100
      : Math.floor(investmentAmount / (config.minimumTradeAmount ?? 1))
        * (config.minimumTradeAmount ?? 1) / candle.close,
    status: 'pending',
  };
  if (order.quantity <= 0) {
    orders.push({ ...order, status: 'rejected', rejectReason: '现金不足' });
    return;
  }

  const result = fillOrder(
    order,
    candle.close,
    portfolio.cash,
    portfolio.positionQuantity,
    {
      ...config,
      dca: { ...config.dca, amount: investmentAmount },
      slippageBps: 0,
      positionSizing: { type: 'percent', value: 1 },
    },
  );
  if (result.trade.quantity > 0) {
    Object.assign(portfolio, applyTrade(portfolio, result.trade));
    trades.push(result.trade);
    orders.push({ ...order, status: 'filled', quantity: result.trade.quantity });
  } else {
    trades.push(result.trade);
    orders.push({ ...order, status: 'rejected', rejectReason: result.error });
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── Shared per-bar processing ─────────────────────────────────────

function processBar(
  i: number,
  totalBars: number,
  candles: Candle[],
  state: BacktestState,
  input: BacktestInput,
): void {
  const { config } = input;
  const { strategy, strategyParams } = input;
  const candle = candles[i];

  // Step 1: Execute pending order at today's open
  if (state.pendingOrder && config.backtestMode === 'strategy') {
    const execTime = candle.time;
    const orderWithTime = { ...state.pendingOrder, executeTime: execTime };

    const result = fillOrder(
      orderWithTime,
      candle.open,
      state.portfolio.cash,
      state.portfolio.positionQuantity,
      state.pendingOrder.targetPosition == null
        ? config
        : { ...config, positionSizing: { type: 'percent', value: 1 } },
    );

    if (result.trade.quantity > 0) {
      applyStrategyTrade(state, result.trade);
      state.trades.push(result.trade);
      orderWithTime.status = 'filled';
      state.orders.push(orderWithTime);
    } else {
      orderWithTime.status = 'rejected';
      orderWithTime.rejectReason = result.error;
      state.orders.push(orderWithTime);
      state.trades.push(result.trade);
    }

    state.pendingOrder = null;
  }

  // Step 2: Generate signal
  const position: PositionSnapshot = {
    quantity: state.portfolio.positionQuantity,
    avgCost: state.portfolio.avgCost,
    entryTime: state.portfolio.entryTime ?? undefined,
    consecutiveLosingTrades: state.consecutiveLosingTrades,
    lastCompletedTradeTime: state.lastCompletedTradeTime ?? undefined,
    positionRatio: (() => {
      const equity = state.portfolio.cash + state.portfolio.positionQuantity * candle.close;
      return equity > 0 ? state.portfolio.positionQuantity * candle.close / equity : 0;
    })(),
    strategyDrawdown: (() => {
      const equity = state.portfolio.cash + state.portfolio.positionQuantity * candle.close;
      const peak = Math.max(state.peakEquity, equity);
      return peak > 0 ? Math.max(0, (peak - equity) / peak) : 0;
    })(),
  };

  const slicedCandles = candles.slice(0, i + 1);
  const indicators: Record<string, readonly (number | null)[]> = {};

  const context = {
    index: i,
    candles: slicedCandles,
    indicators,
    position,
  };

  const signal = config.backtestMode === 'dca'
    ? createDcaSignal(candles, i, config)
    : strategy!.evaluate(context, strategyParams);
  state.signals.push(signal);

  // Step 3: Create order from signal
  if (config.backtestMode === 'dca' && signal.action === 'buy') {
    executeDcaPurchase(
      signal,
      candle,
      state.portfolio,
      config,
      state.orders,
      state.trades,
      i === 0 ? config.initialCapital : config.dca.amount,
    );
  } else if (signal.action !== 'hold' && i < totalBars - 1) {
    const nextCandle = candles[i + 1];

    if (signal.targetPosition != null) {
      state.pendingOrder = createTargetPositionOrder(
        signal,
        nextCandle,
        state.portfolio,
        config,
      );
    } else if (signal.action === 'buy') {
      state.pendingOrder = createBuyOrder(signal, nextCandle, state.portfolio.cash, config);
      if (!state.pendingOrder) {
        state.orders.push({
          id: crypto.randomUUID(),
          signalTime: signal.time,
          executeTime: nextCandle.time,
          side: 'buy',
          orderType: 'market',
          quantity: 0,
          status: 'rejected',
          rejectReason: '现金不足',
        });
      }
    } else if (signal.action === 'sell') {
      if (state.portfolio.positionQuantity > 0) {
        state.pendingOrder = createSellOrder(
          signal,
          state.portfolio.positionQuantity,
          nextCandle.open * (1 - config.slippageBps / 10000),
          config,
        );
      } else {
        state.orders.push({
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
  } else if (config.backtestMode === 'strategy' && signal.action !== 'hold' && i === totalBars - 1) {
    state.signals[state.signals.length - 1] = {
      ...signal,
      action: 'hold',
      reason: '最后一根 K 线信号取消',
    };
  }

  // Step 4: Daily equity snapshot
  const point = createEquityPoint(candle.time, state.portfolio, candle.close, state.peakEquity);
  if (point.equity > state.peakEquity) {
    state.peakEquity = point.equity;
  }
  state.equityCurve.push(point);

  // Step 5: Force close at end
  if (i === totalBars - 1 && config.backtestMode === 'strategy' && config.forceCloseAtEnd && state.portfolio.positionQuantity > 0) {
    state.pendingOrder = null;

    const forceCloseTrade: Trade = {
      id: crypto.randomUUID(),
      orderId: 'force-close',
      time: candle.time,
      side: 'sell',
      quantity: state.portfolio.positionQuantity,
      rawPrice: candle.close,
      fillPrice: candle.close,
      commission: Math.max(
        state.portfolio.positionQuantity * candle.close * config.commissionRate,
        config.minimumCommission,
      ),
      tax: state.portfolio.positionQuantity * candle.close * config.sellTaxRate,
      slippageCost: 0,
      amount: state.portfolio.positionQuantity * candle.close,
      forceClose: true,
    };

    applyStrategyTrade(state, forceCloseTrade);
    state.trades.push(forceCloseTrade);

    const forceCloseOrder: Order = {
      id: 'force-close',
      signalTime: candle.time,
      executeTime: candle.time,
      side: 'sell',
      orderType: 'market',
      quantity: forceCloseTrade.quantity,
      status: 'filled',
    };
    state.orders.push(forceCloseOrder);

    const finalPoint = createEquityPoint(candle.time, state.portfolio, candle.close, state.peakEquity);
    state.equityCurve[state.equityCurve.length - 1] = finalPoint;
  }
}

// ─── Result assembly ───────────────────────────────────────────────

function buildResult(input: BacktestInput, state: BacktestState): BacktestResult {
  const { candles, config, strategy, strategyParams, datasetId, datasetName, datasetChecksum, resultName } = input;

  const metrics = calculateMetrics(state.equityCurve, state.trades, config.initialCapital);

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
      name: datasetName,
      symbol: candles[0]?.symbol ?? '',
      startTime: candles[0]?.time ?? '',
      endTime: candles[candles.length - 1]?.time ?? '',
      checksum: datasetChecksum,
    },
    strategyId: config.backtestMode === 'dca' ? 'dca' : strategy!.id,
    strategyVersion: config.backtestMode === 'dca' ? '1.0' : strategy!.version,
    strategyParams: config.backtestMode === 'dca' ? {} : strategyParams,
    config,
    startedAt: now,
    completedAt: now,
    metrics,
    signals: state.signals,
    trades: state.trades,
    equityCurve: state.equityCurve,
  };
}

function createInitialState(input: BacktestInput): BacktestState {
  return {
    portfolio: createPortfolio(
      input.config.backtestMode === 'dca' ? 0 : input.config.initialCapital,
    ),
    signals: [],
    orders: [],
    trades: [],
    equityCurve: [],
    peakEquity: input.config.initialCapital,
    pendingOrder: null,
    currentPositionPnl: 0,
    consecutiveLosingTrades: 0,
    lastCompletedTradeTime: null,
  };
}

// ─── Public API ────────────────────────────────────────────────────

export async function runBacktestAsync(
  input: BacktestInput,
  onProgress?: (progress: BacktestProgress) => void,
  isCancelled?: () => boolean,
): Promise<BacktestResult> {
  const errors = validateBacktestInput(input.candles, input.config);
  if (errors.length > 0) {
    return createFailedResult(input, errors.map((e) => e.message).join('; '));
  }

  const state = createInitialState(input);
  const totalBars = input.candles.length;

  for (let i = 0; i < totalBars; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) {
      if (isCancelled?.()) return createCancelledResult(input);
      await yieldToEventLoop();
    }

    processBar(i, totalBars, input.candles, state, input);

    onProgress?.({
      current: i + 1,
      total: totalBars,
      message: `回测中... ${i + 1}/${totalBars}`,
    });
  }

  return buildResult(input, state);
}

export function runBacktest(
  input: BacktestInput,
  onProgress?: (progress: BacktestProgress) => void,
): BacktestResult {
  const errors = validateBacktestInput(input.candles, input.config);
  if (errors.length > 0) {
    return createFailedResult(input, errors.map((e) => e.message).join('; '));
  }

  const state = createInitialState(input);
  const totalBars = input.candles.length;

  for (let i = 0; i < totalBars; i++) {
    processBar(i, totalBars, input.candles, state, input);

    onProgress?.({
      current: i + 1,
      total: totalBars,
      message: `回测中... ${i + 1}/${totalBars}`,
    });
  }

  return buildResult(input, state);
}

// ─── Error / cancelled result factories ────────────────────────────

function createCancelledResult(input: BacktestInput): BacktestResult {
  const now = new Date().toISOString();
  const { candles, strategy, strategyParams, config, datasetId, datasetName, datasetChecksum, resultName } = input;
  return {
    id: crypto.randomUUID(),
    name: resultName,
    status: 'cancelled',
    datasetSnapshot: {
      id: datasetId,
      name: datasetName,
      symbol: candles[0]?.symbol ?? '',
      startTime: candles[0]?.time ?? '',
      endTime: candles.length > 0 ? candles[candles.length - 1].time : '',
      checksum: datasetChecksum,
    },
    strategyId: config.backtestMode === 'dca' ? 'dca' : strategy!.id,
    strategyVersion: config.backtestMode === 'dca' ? '1.0' : strategy!.version,
    strategyParams: config.backtestMode === 'dca' ? {} : strategyParams,
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
  const { candles, strategy, strategyParams, config, datasetId, datasetName, datasetChecksum, resultName } = input;
  return {
    id: crypto.randomUUID(),
    name: resultName,
    status: 'failed',
    datasetSnapshot: {
      id: datasetId,
      name: datasetName,
      symbol: candles[0]?.symbol ?? '',
      startTime: candles[0]?.time ?? '',
      endTime: candles.length > 0 ? candles[candles.length - 1].time : '',
      checksum: datasetChecksum,
    },
    strategyId: config.backtestMode === 'dca' ? 'dca' : strategy!.id,
    strategyVersion: config.backtestMode === 'dca' ? '1.0' : strategy!.version,
    strategyParams: config.backtestMode === 'dca' ? {} : strategyParams,
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
    netContributions: initialCapital,
    finalEquity: initialCapital,
    totalReturn: 0,
    annualizedReturn: 0,
    annualizedVolatility: 0,
    riskReturnRatio: 0,
    returnMddRatio: 0,
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
