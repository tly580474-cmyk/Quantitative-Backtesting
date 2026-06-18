import type { Trade, EquityPoint } from '@/models';
import { roundTo } from '@/utils/number';

export interface PortfolioState {
  cash: number;
  positionQuantity: number;
  avgCost: number;
  totalCommission: number;
  totalTax: number;
  totalSlippage: number;
}

export function createPortfolio(initialCapital: number): PortfolioState {
  return {
    cash: initialCapital,
    positionQuantity: 0,
    avgCost: 0,
    totalCommission: 0,
    totalTax: 0,
    totalSlippage: 0,
  };
}

/**
 * Apply a filled trade to the portfolio.
 */
export function applyTrade(portfolio: PortfolioState, trade: Trade): PortfolioState {
  const next = { ...portfolio };

  if (trade.side === 'buy') {
    const totalCost = trade.amount + trade.commission;
    const newTotalCost = next.positionQuantity * next.avgCost + trade.amount;
    next.positionQuantity += trade.quantity;
    next.avgCost = next.positionQuantity > 0 ? newTotalCost / next.positionQuantity : 0;
    next.cash -= totalCost;
  } else {
    // Sell
    const proceeds = trade.amount - trade.commission - trade.tax;
    next.positionQuantity -= trade.quantity;
    if (next.positionQuantity === 0) {
      next.avgCost = 0;
    }
    next.cash += proceeds;
  }

  next.totalCommission = roundTo(next.totalCommission + trade.commission, 4);
  next.totalTax = roundTo(next.totalTax + trade.tax, 4);
  next.totalSlippage = roundTo(next.totalSlippage + trade.slippageCost, 4);

  return next;
}

/**
 * Compute equity at current close price.
 */
export function computeEquity(portfolio: PortfolioState, closePrice: number): number {
  const marketValue = portfolio.positionQuantity * closePrice;
  return portfolio.cash + marketValue;
}

/**
 * Create a daily equity snapshot.
 */
export function createEquityPoint(
  time: string,
  portfolio: PortfolioState,
  closePrice: number,
  peakEquity: number,
): EquityPoint {
  const marketValue = portfolio.positionQuantity * closePrice;
  const equity = portfolio.cash + marketValue;
  const drawdown = peakEquity > 0 ? (equity - peakEquity) / peakEquity : 0;

  return {
    time,
    cash: roundTo(portfolio.cash, 4),
    marketValue: roundTo(marketValue, 4),
    equity: roundTo(equity, 4),
    drawdown: roundTo(Math.min(drawdown, 0), 6),
    positionQuantity: portfolio.positionQuantity,
  };
}
