import type { Candle } from '@/models';

export interface WindowParams {
  period: number;
}

export interface VolatilityResult {
  volatility: (number | null)[];
  annualVolatility: (number | null)[];
}

export interface HoldResult {
  holdReturn: (number | null)[];
  holdNav: (number | null)[];
}

const TRADING_DAYS_PER_YEAR = 252;

function calculateReturns(candles: Candle[]): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    result[i] = prevClose > 0 ? candles[i].close / prevClose - 1 : null;
  }
  return result;
}

function rollingMean(values: number[], start: number, end: number): number {
  let sum = 0;
  for (let i = start; i <= end; i++) sum += values[i];
  return sum / (end - start + 1);
}

function rollingStd(values: (number | null)[], start: number, end: number): number | null {
  const sample: number[] = [];
  for (let i = start; i <= end; i++) {
    const value = values[i];
    if (value == null || !Number.isFinite(value)) return null;
    sample.push(value);
  }
  if (sample.length < 2) return null;
  const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
  const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sample.length - 1);
  return Math.sqrt(variance);
}

function rollingCorrelation(
  left: (number | null)[],
  right: (number | null)[],
  start: number,
  end: number,
): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = start; i <= end; i++) {
    const x = left[i];
    const y = right[i];
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 2) return null;

  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (let i = 0; i < xs.length; i++) {
    const xDiff = xs[i] - xMean;
    const yDiff = ys[i] - yMean;
    covariance += xDiff * yDiff;
    xVariance += xDiff ** 2;
    yVariance += yDiff ** 2;
  }
  const denominator = Math.sqrt(xVariance * yVariance);
  return denominator > 0 ? covariance / denominator : null;
}

export function calculateBIAS(candles: Candle[], params: WindowParams): (number | null)[] {
  const { period } = params;
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (period < 2 || candles.length < period) return result;

  const closes = candles.map((candle) => candle.close);
  for (let i = period - 1; i < candles.length; i++) {
    const ma = rollingMean(closes, i - period + 1, i);
    result[i] = ma !== 0 ? (candles[i].close - ma) / ma : null;
  }
  return result;
}

export function calculateVolatility(candles: Candle[], params: WindowParams): VolatilityResult {
  const { period } = params;
  const volatility: (number | null)[] = new Array(candles.length).fill(null);
  const annualVolatility: (number | null)[] = new Array(candles.length).fill(null);
  if (period < 2 || candles.length < period + 1) return { volatility, annualVolatility };

  const returns = calculateReturns(candles);
  for (let i = period; i < candles.length; i++) {
    const value = rollingStd(returns, i - period + 1, i);
    volatility[i] = value;
    annualVolatility[i] = value == null ? null : value * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }
  return { volatility, annualVolatility };
}

export function calculateVolCluster(candles: Candle[], params: WindowParams): (number | null)[] {
  const { period } = params;
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (period < 2 || candles.length < period + 2) return result;

  const returns = calculateReturns(candles);
  const absReturns = returns.map((value) => (value == null ? null : Math.abs(value)));
  const shiftedAbsReturns = absReturns.map((_, index) => (index > 0 ? absReturns[index - 1] : null));
  for (let i = period + 1; i < candles.length; i++) {
    result[i] = rollingCorrelation(absReturns, shiftedAbsReturns, i - period + 1, i);
  }
  return result;
}

export function calculateHold(candles: Candle[]): HoldResult {
  const holdReturn: (number | null)[] = new Array(candles.length).fill(null);
  const holdNav: (number | null)[] = new Array(candles.length).fill(null);
  const firstClose = candles[0]?.close;
  if (!firstClose || firstClose <= 0) return { holdReturn, holdNav };

  for (let i = 0; i < candles.length; i++) {
    holdNav[i] = candles[i].close / firstClose;
    holdReturn[i] = holdNav[i]! - 1;
  }
  return { holdReturn, holdNav };
}

export function calculateReversal(candles: Candle[], params: WindowParams): (number | null)[] {
  const { period } = params;
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (period < 1 || candles.length < period + 1) return result;

  for (let i = period; i < candles.length; i++) {
    const pastClose = candles[i - period].close;
    result[i] = pastClose > 0 ? -(candles[i].close / pastClose - 1) : null;
  }
  return result;
}

export function calculateReturnElasticity(
  assetCandles: Candle[],
  benchmarkCandles: Candle[],
  params: WindowParams,
): (number | null)[] {
  const { period } = params;
  const result: (number | null)[] = new Array(assetCandles.length).fill(null);
  if (period < 2 || assetCandles.length < period + 1 || benchmarkCandles.length !== assetCandles.length) {
    return result;
  }

  const assetReturns = calculateReturns(assetCandles);
  const benchmarkReturns = calculateReturns(benchmarkCandles);
  for (let i = period; i < assetCandles.length; i++) {
    const start = i - period + 1;
    const assetWindow: number[] = [];
    const benchmarkWindow: number[] = [];
    for (let j = start; j <= i; j++) {
      const assetReturn = assetReturns[j];
      const benchmarkReturn = benchmarkReturns[j];
      if (
        assetReturn == null
        || benchmarkReturn == null
        || !Number.isFinite(assetReturn)
        || !Number.isFinite(benchmarkReturn)
      ) {
        assetWindow.length = 0;
        break;
      }
      assetWindow.push(assetReturn);
      benchmarkWindow.push(benchmarkReturn);
    }
    if (assetWindow.length < 2) continue;

    const assetMean = assetWindow.reduce((sum, value) => sum + value, 0) / assetWindow.length;
    const benchmarkMean = benchmarkWindow.reduce((sum, value) => sum + value, 0) / benchmarkWindow.length;
    let covariance = 0;
    let benchmarkVariance = 0;
    for (let j = 0; j < assetWindow.length; j++) {
      covariance += (assetWindow[j] - assetMean) * (benchmarkWindow[j] - benchmarkMean);
      benchmarkVariance += (benchmarkWindow[j] - benchmarkMean) ** 2;
    }
    result[i] = benchmarkVariance > 0 ? covariance / benchmarkVariance : null;
  }

  return result;
}
