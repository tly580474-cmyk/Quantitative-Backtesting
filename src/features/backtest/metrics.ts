import type { BacktestMetrics, EquityPoint, Trade } from '@/models';
import { roundTo } from '@/utils/number';

const TRADING_DAYS_PER_YEAR = 252;

export function calculateMetrics(
  equityCurve: EquityPoint[],
  trades: Trade[],
  initialCapital: number,
): BacktestMetrics {
  const finalEquity = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1].equity
    : initialCapital;
  const netContributions = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1].contributedCapital ?? initialCapital
    : initialCapital;

  const totalReturn = netContributions > 0
    ? (finalEquity - netContributions) / netContributions
    : 0;
  const tradingDays = equityCurve.length;

  // Time-weighted daily returns remove external DCA contributions before
  // measuring investment performance.
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) {
      const previousContributions = equityCurve[i - 1].contributedCapital ?? initialCapital;
      const currentContributions = equityCurve[i].contributedCapital ?? previousContributions;
      const externalFlow = currentContributions - previousContributions;
      dailyReturns.push((equityCurve[i].equity - externalFlow) / prev - 1);
    }
  }
  const timeWeightedGrowth = dailyReturns.reduce((growth, value) => growth * (1 + value), 1);
  const annualizedReturn = dailyReturns.length > 0 && timeWeightedGrowth > 0
    ? Math.pow(timeWeightedGrowth, TRADING_DAYS_PER_YEAR / dailyReturns.length) - 1
    : 0;
  const avgDailyReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    : 0;
  const variance = dailyReturns.length > 1
    ? dailyReturns.reduce((sum, r) => sum + (r - avgDailyReturn) ** 2, 0) / (dailyReturns.length - 1)
    : 0;
  const annualizedVolatility = Math.sqrt(variance * TRADING_DAYS_PER_YEAR);

  // Sharpe ratio (assuming risk-free rate of 0.02)
  const riskFreeRate = 0.02;
  const sharpeRatio = annualizedVolatility > 0
    ? (annualizedReturn - riskFreeRate) / annualizedVolatility
    : 0;

  // Max drawdown on a unitized NAV, so deposits do not hide drawdowns.
  let nav = 1;
  let peak = 1;
  let peakTime = equityCurve.length > 0 ? equityCurve[0].time : '';
  let maxDrawdown = 0;
  let maxDdStart = '';
  let maxDdEnd = '';

  for (let i = 1; i < equityCurve.length; i++) {
    nav *= 1 + dailyReturns[i - 1];
    const point = equityCurve[i];
    if (nav > peak) {
      peak = nav;
      peakTime = point.time;
    } else {
      const dd = (peak - nav) / peak;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        maxDdStart = peakTime;
        maxDdEnd = point.time;
      }
    }
  }

  // Trade statistics
  const filledTrades = trades.filter((t) => t.quantity > 0);
  const sellTrades = filledTrades.filter((t) => t.side === 'sell');
  const buyTrades = filledTrades.filter((t) => t.side === 'buy');

  let winCount = 0;
  let lossCount = 0;
  let totalProfit = 0;
  let totalLoss = 0;
  let totalHoldingDays = 0;
  let pairCount = 0;

  // Match quantities FIFO so recurring investments and partial exits do not
  // count the same sell proceeds more than once.
  const lots = buyTrades.map((buy) => ({
    remaining: buy.quantity,
    unitCost: (buy.amount + buy.commission) / buy.quantity,
    time: buy.time,
  }));
  let lotIndex = 0;
  for (const sell of sellTrades) {
    let quantityToMatch = sell.quantity;
    let matchedCost = 0;
    let weightedHoldingDays = 0;
    let matchedQuantity = 0;
    while (quantityToMatch > 0 && lotIndex < lots.length) {
      const lot = lots[lotIndex];
      const matched = Math.min(quantityToMatch, lot.remaining);
      matchedCost += matched * lot.unitCost;
      weightedHoldingDays += matched * (
        (new Date(sell.time).getTime() - new Date(lot.time).getTime()) / 86400000
      );
      matchedQuantity += matched;
      lot.remaining -= matched;
      quantityToMatch -= matched;
      if (lot.remaining <= 1e-10) lotIndex++;
    }
    if (matchedQuantity > 0) {
      const netProceeds = sell.amount - sell.commission - sell.tax;
      const pnl = netProceeds - matchedCost;
      if (pnl > 0) {
        winCount++;
        totalProfit += pnl;
      } else {
        lossCount++;
        totalLoss += Math.abs(pnl);
      }
      totalHoldingDays += weightedHoldingDays / matchedQuantity;
      pairCount++;
    }
  }

  const tradeCount = sellTrades.length;
  const winRate = tradeCount > 0 ? winCount / tradeCount : 0;
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? Infinity : 0);
  const avgHoldingDays = pairCount > 0 ? totalHoldingDays / pairCount : 0;

  // Benchmark return (buy and hold from first to last candle)
  // This is approximate — actual benchmark depends on the underlying
  const benchmarkReturn = totalReturn; // Placeholder; will be replaced with actual benchmark

  return {
    initialCapital: roundTo(initialCapital, 2),
    netContributions: roundTo(netContributions, 2),
    finalEquity: roundTo(finalEquity, 2),
    totalReturn: roundTo(totalReturn, 6),
    annualizedReturn: roundTo(annualizedReturn, 6),
    annualizedVolatility: roundTo(annualizedVolatility, 6),
    sharpeRatio: roundTo(sharpeRatio, 4),
    maxDrawdown: roundTo(maxDrawdown, 6),
    maxDrawdownStart: maxDdStart,
    maxDrawdownEnd: maxDdEnd,
    tradeCount,
    winRate: roundTo(winRate, 4),
    profitFactor: roundTo(Math.min(profitFactor, 999), 4),
    avgHoldingDays: roundTo(avgHoldingDays, 1),
    totalCommission: roundTo(
      filledTrades.reduce((s, t) => s + t.commission, 0),
      4,
    ),
    totalTax: roundTo(filledTrades.reduce((s, t) => s + t.tax, 0), 4),
    totalSlippage: roundTo(
      filledTrades.reduce((s, t) => s + t.slippageCost, 0),
      4,
    ),
    benchmarkReturn: roundTo(benchmarkReturn, 6),
    excessReturn: roundTo(totalReturn - benchmarkReturn, 6),
  };
}
