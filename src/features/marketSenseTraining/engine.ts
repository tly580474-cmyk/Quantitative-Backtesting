import type { KlinePoint } from '@/features/marketData/types';
import {
  applySlippage,
  calculateCommission,
  calculateSellTax,
  normalizeStockBuyQuantity,
  normalizeStockSellQuantity,
  roundMoney,
} from '../../../shared/trading-rules/index.js';

export const TRAINING_INITIAL_CASH = 1_000_000;
export const TRAINING_COMMISSION_RATE = 0.0003;
export const TRAINING_MINIMUM_COMMISSION = 5;
export const TRAINING_SELL_TAX_RATE = 0.0005;
export const TRAINING_SLIPPAGE_BPS = 2;

export interface TrainingLot {
  quantity: number;
  buyIndex: number;
}

export interface TrainingTrade {
  id: string;
  side: 'buy' | 'sell';
  date: string;
  barIndex: number;
  price: number;
  quantity: number;
  commission: number;
  tax: number;
  realizedPnl: number;
}

export interface TrainingEquityPoint {
  date: string;
  equity: number;
}

export interface TrainingPortfolio {
  cash: number;
  quantity: number;
  averageCost: number;
  lots: TrainingLot[];
  trades: TrainingTrade[];
  equityCurve: TrainingEquityPoint[];
  realizedPnl: number;
}

export interface TrainingSummary {
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  tradeCount: number;
  winRatePct: number;
}

export interface TradeResult {
  portfolio: TrainingPortfolio;
  error?: string;
}

export function createTrainingPortfolio(): TrainingPortfolio {
  return {
    cash: TRAINING_INITIAL_CASH,
    quantity: 0,
    averageCost: 0,
    lots: [],
    trades: [],
    equityCurve: [],
    realizedPnl: 0,
  };
}

export function availableToSell(portfolio: TrainingPortfolio, barIndex: number): number {
  return portfolio.lots
    .filter((lot) => lot.buyIndex < barIndex)
    .reduce((sum, lot) => sum + lot.quantity, 0);
}

export function portfolioEquity(portfolio: TrainingPortfolio, price: number): number {
  return roundMoney(portfolio.cash + portfolio.quantity * price);
}

export function recordEquity(
  portfolio: TrainingPortfolio,
  bar: KlinePoint,
): TrainingPortfolio {
  const equity = portfolioEquity(portfolio, bar.close);
  const previous = portfolio.equityCurve[portfolio.equityCurve.length - 1];
  if (previous?.date === bar.date && previous.equity === equity) return portfolio;
  const equityCurve = previous?.date === bar.date
    ? [...portfolio.equityCurve.slice(0, -1), { date: bar.date, equity }]
    : [...portfolio.equityCurve, { date: bar.date, equity }];
  return { ...portfolio, equityCurve };
}

function affordableBuyQuantity(cash: number, price: number, requestedQuantity: number): number {
  let quantity = normalizeStockBuyQuantity(requestedQuantity);
  while (quantity > 0) {
    const amount = price * quantity;
    const commission = calculateCommission(
      amount,
      TRAINING_COMMISSION_RATE,
      TRAINING_MINIMUM_COMMISSION,
    );
    if (amount + commission <= cash) return quantity;
    quantity -= 100;
  }
  return 0;
}

function reduceLots(lots: TrainingLot[], quantity: number, barIndex: number): TrainingLot[] {
  let remaining = quantity;
  return lots.flatMap((lot) => {
    if (remaining <= 0 || lot.buyIndex >= barIndex) return [lot];
    const sold = Math.min(lot.quantity, remaining);
    remaining -= sold;
    const rest = lot.quantity - sold;
    return rest > 0 ? [{ ...lot, quantity: rest }] : [];
  });
}

export function executeTrainingTrade(
  portfolio: TrainingPortfolio,
  side: 'buy' | 'sell',
  requestedQuantity: number,
  bar: KlinePoint,
  barIndex: number,
): TradeResult {
  if (!bar.isTradable && bar.isTradable !== undefined) {
    return { portfolio, error: '该交易日停牌，无法成交' };
  }
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    return { portfolio, error: '请输入有效的交易数量' };
  }

  const price = applySlippage(bar.close, side, TRAINING_SLIPPAGE_BPS);
  if (side === 'buy') {
    const quantity = affordableBuyQuantity(portfolio.cash, price, requestedQuantity);
    if (quantity <= 0) return { portfolio, error: '可用资金不足，至少需要买入 1 手' };
    const amount = price * quantity;
    const commission = calculateCommission(
      amount,
      TRAINING_COMMISSION_RATE,
      TRAINING_MINIMUM_COMMISSION,
    );
    const totalCost = amount + commission;
    const nextQuantity = portfolio.quantity + quantity;
    const nextAverageCost = (
      portfolio.averageCost * portfolio.quantity + totalCost
    ) / nextQuantity;
    const next = recordEquity({
      ...portfolio,
      cash: roundMoney(portfolio.cash - totalCost),
      quantity: nextQuantity,
      averageCost: nextAverageCost,
      lots: [...portfolio.lots, { quantity, buyIndex: barIndex }],
      trades: [...portfolio.trades, {
        id: `${bar.date}-buy-${portfolio.trades.length + 1}`,
        side,
        date: bar.date,
        barIndex,
        price,
        quantity,
        commission,
        tax: 0,
        realizedPnl: 0,
      }],
    }, bar);
    return { portfolio: next };
  }

  const available = availableToSell(portfolio, barIndex);
  if (available <= 0) return { portfolio, error: '当前没有可卖持仓；当日买入需下一交易日卖出' };
  const quantity = normalizeStockSellQuantity(requestedQuantity, available);
  if (quantity <= 0) return { portfolio, error: '卖出数量不足 1 手' };
  const amount = price * quantity;
  const commission = calculateCommission(
    amount,
    TRAINING_COMMISSION_RATE,
    TRAINING_MINIMUM_COMMISSION,
  );
  const tax = calculateSellTax(amount, TRAINING_SELL_TAX_RATE);
  const realizedPnl = roundMoney(
    amount - commission - tax - portfolio.averageCost * quantity,
  );
  const nextQuantity = portfolio.quantity - quantity;
  const next = recordEquity({
    ...portfolio,
    cash: roundMoney(portfolio.cash + amount - commission - tax),
    quantity: nextQuantity,
    averageCost: nextQuantity > 0 ? portfolio.averageCost : 0,
    lots: reduceLots(portfolio.lots, quantity, barIndex),
    trades: [...portfolio.trades, {
      id: `${bar.date}-sell-${portfolio.trades.length + 1}`,
      side,
      date: bar.date,
      barIndex,
      price,
      quantity,
      commission,
      tax,
      realizedPnl,
    }],
    realizedPnl: roundMoney(portfolio.realizedPnl + realizedPnl),
  }, bar);
  return { portfolio: next };
}

export function calculateFullPositionQuantity(
  portfolio: TrainingPortfolio,
  price: number,
): number {
  const executionPrice = applySlippage(price, 'buy', TRAINING_SLIPPAGE_BPS);
  const estimated = normalizeStockBuyQuantity(portfolio.cash / executionPrice);
  return affordableBuyQuantity(portfolio.cash, executionPrice, estimated);
}

export function summarizeTraining(
  portfolio: TrainingPortfolio,
  lastPrice: number,
): TrainingSummary {
  const finalEquity = portfolioEquity(portfolio, lastPrice);
  let peak = TRAINING_INITIAL_CASH;
  let maxDrawdown = 0;
  for (const point of portfolio.equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak);
  }
  const completed = portfolio.trades.filter((trade) => trade.side === 'sell');
  const wins = completed.filter((trade) => trade.realizedPnl > 0).length;
  return {
    finalEquity,
    totalReturnPct: (finalEquity / TRAINING_INITIAL_CASH - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    realizedPnl: portfolio.realizedPnl,
    unrealizedPnl: roundMoney((lastPrice - portfolio.averageCost) * portfolio.quantity),
    tradeCount: portfolio.trades.length,
    winRatePct: completed.length > 0 ? wins / completed.length * 100 : 0,
  };
}
