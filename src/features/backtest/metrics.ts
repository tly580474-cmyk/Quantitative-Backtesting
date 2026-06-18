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

  const totalReturn = (finalEquity - initialCapital) / initialCapital;
  const tradingDays = equityCurve.length;
  const annualizedReturn = tradingDays > 0
    ? Math.pow(1 + totalReturn, TRADING_DAYS_PER_YEAR / tradingDays) - 1
    : 0;

  // Annualized volatility
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) {
      dailyReturns.push(equityCurve[i].equity / prev - 1);
    }
  }
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

  // Max drawdown
  let peak = equityCurve.length > 0 ? equityCurve[0].equity : initialCapital;
  let maxDrawdown = 0;
  let maxDdStart = '';
  let maxDdEnd = '';
  let ddStart = '';

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
      ddStart = '';
    } else {
      if (ddStart === '') ddStart = point.time;
      const dd = (peak - point.equity) / peak;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        maxDdStart = ddStart;
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

  // Match buy-sell pairs
  let buyIdx = 0;
  for (const sell of sellTrades) {
    // Find matching buy
    while (buyIdx < buyTrades.length && buyTrades[buyIdx].time <= sell.time) {
      const buy = buyTrades[buyIdx];
      const pnl = sell.amount - sell.commission - sell.tax - buy.amount - buy.commission;
      if (pnl > 0) {
        winCount++;
        totalProfit += pnl;
      } else {
        lossCount++;
        totalLoss += Math.abs(pnl);
      }
      const buyDate = new Date(buy.time);
      const sellDate = new Date(sell.time);
      totalHoldingDays += (sellDate.getTime() - buyDate.getTime()) / 86400000;
      pairCount++;
      buyIdx++;
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
