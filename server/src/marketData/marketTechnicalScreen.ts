import type { KlinePoint, MarketTechnicalRow } from './aStockDataService.js';

export type TrendFilter = 'any' | 'bullish' | 'aboveMa20' | 'bearish';
export type DirectionFilter = 'any' | 'up' | 'down';
export type CrossFilter = 'any' | 'golden' | 'death';

export interface MarketTechnicalScreenCriteria {
  markets: Array<'SH' | 'SZ' | 'BJ'>;
  minChangePct: number;
  maxChangePct: number;
  minAmountYi: number;
  minTurnoverPct: number;
  minVolumeRatio: number;
  maxAmplitudePct: number;
  excludeRiskNames: boolean;
  trend: TrendFilter;
  returnPeriod: 5 | 10 | 20;
  minPeriodReturn: number;
  maxPeriodReturn: number;
  streakDirection: DirectionFilter;
  minStreakDays: number;
  minRsi: number;
  maxRsi: number;
  kdjSignal: CrossFilter;
  macdSignal: CrossFilter;
  limit: number;
}

export interface HistoricalTechnicalIndicators {
  asOf: string;
  close: number;
  ma5: number;
  ma10: number;
  ma20: number;
  ma60: number;
  trend: Exclude<TrendFilter, 'any'> | 'mixed';
  return5d: number;
  return10d: number;
  return20d: number;
  streak: number;
  rsi14: number;
  kdjK: number;
  kdjD: number;
  kdjJ: number;
  kdjSignal: Exclude<CrossFilter, 'any'> | 'none';
  macdDif: number;
  macdDea: number;
  macdHistogram: number;
  macdSignal: Exclude<CrossFilter, 'any'> | 'none';
}

export interface MarketTechnicalCandidate extends MarketTechnicalRow {
  technicalScore: number;
  matchedSignals: string[];
  indicators: HistoricalTechnicalIndicators | null;
}

function finiteOr(value: number | null, fallback: number): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function sma(closes: number[], period: number): number {
  return average(closes.slice(-period));
}

function periodReturn(closes: number[], period: number): number {
  const start = closes[closes.length - 1 - period];
  return start > 0 ? (closes[closes.length - 1] / start - 1) * 100 : 0;
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index++) {
    result.push(values[index] * multiplier + result[index - 1] * (1 - multiplier));
  }
  return result;
}

function rsi14(closes: number[]): number {
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= 14; index++) {
    const change = closes[index] - closes[index - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let index = 15; index < closes.length; index++) {
    const change = closes[index] - closes[index - 1];
    avgGain = (avgGain * 13 + Math.max(0, change)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(0, -change)) / 14;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function kdj(candles: KlinePoint[]) {
  let k = 50;
  let d = 50;
  let previousK = k;
  let previousD = d;
  for (let index = 8; index < candles.length; index++) {
    previousK = k;
    previousD = d;
    const window = candles.slice(index - 8, index + 1);
    const low = Math.min(...window.map((item) => item.low));
    const high = Math.max(...window.map((item) => item.high));
    const rsv = high === low ? 50 : ((candles[index].close - low) / (high - low)) * 100;
    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
  }
  const signal = previousK <= previousD && k > d ? 'golden'
    : previousK >= previousD && k < d ? 'death'
      : 'none';
  return { k, d, j: 3 * k - 2 * d, signal } as const;
}

function macd(closes: number[]) {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const dif = fast.map((value, index) => value - slow[index]);
  const dea = ema(dif, 9);
  const current = dif.length - 1;
  const previous = current - 1;
  const signal = dif[previous] <= dea[previous] && dif[current] > dea[current] ? 'golden'
    : dif[previous] >= dea[previous] && dif[current] < dea[current] ? 'death'
      : 'none';
  return {
    dif: dif[current],
    dea: dea[current],
    histogram: (dif[current] - dea[current]) * 2,
    signal,
  } as const;
}

function streak(closes: number[]): number {
  let result = 0;
  for (let index = closes.length - 1; index > 0; index--) {
    const direction = closes[index] > closes[index - 1] ? 1 : closes[index] < closes[index - 1] ? -1 : 0;
    if (direction === 0 || (result !== 0 && Math.sign(result) !== direction)) break;
    result += direction;
  }
  return result;
}

export function analyzeHistoricalTechnicals(input: KlinePoint[]): HistoricalTechnicalIndicators | null {
  const candles = [...input]
    .filter((item) => [item.open, item.high, item.low, item.close].every(Number.isFinite))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (candles.length < 65) return null;
  const closes = candles.map((item) => item.close);
  const close = closes[closes.length - 1];
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const trend = close > ma5 && ma5 > ma10 && ma10 > ma20 && ma20 > ma60 ? 'bullish'
    : close < ma5 && ma5 < ma10 && ma10 < ma20 && ma20 < ma60 ? 'bearish'
      : close >= ma20 ? 'aboveMa20'
        : 'mixed';
  const kdjValue = kdj(candles);
  const macdValue = macd(closes);
  return {
    asOf: candles[candles.length - 1].date,
    close: round(close),
    ma5: round(ma5),
    ma10: round(ma10),
    ma20: round(ma20),
    ma60: round(ma60),
    trend,
    return5d: round(periodReturn(closes, 5)),
    return10d: round(periodReturn(closes, 10)),
    return20d: round(periodReturn(closes, 20)),
    streak: streak(closes),
    rsi14: round(rsi14(closes), 1),
    kdjK: round(kdjValue.k, 1),
    kdjD: round(kdjValue.d, 1),
    kdjJ: round(kdjValue.j, 1),
    kdjSignal: kdjValue.signal,
    macdDif: round(macdValue.dif, 3),
    macdDea: round(macdValue.dea, 3),
    macdHistogram: round(macdValue.histogram, 3),
    macdSignal: macdValue.signal,
  };
}

function candidateScore(
  row: MarketTechnicalRow,
  indicators: HistoricalTechnicalIndicators | null = null,
): Pick<MarketTechnicalCandidate, 'technicalScore' | 'matchedSignals'> {
  const change = finiteOr(row.changePct, 0);
  const amount = finiteOr(row.amountYi, 0);
  const turnover = finiteOr(row.turnoverPct, 0);
  const volumeRatio = finiteOr(row.volumeRatio, 0);
  const amplitude = finiteOr(row.amplitudePct, 0);
  const matchedSignals: string[] = [];
  if (change > 0) matchedSignals.push('收涨');
  if (amount >= 5) matchedSignals.push('成交活跃');
  if (volumeRatio >= 1.2) matchedSignals.push('量能放大');
  if (indicators?.trend === 'bullish') matchedSignals.push('均线多头');
  else if (indicators?.trend === 'aboveMa20') matchedSignals.push('站上MA20');
  if ((indicators?.return20d ?? 0) > 5) matchedSignals.push('20日动量');
  if ((indicators?.streak ?? 0) >= 3) matchedSignals.push(`连涨${indicators!.streak}日`);
  if (indicators?.kdjSignal === 'golden') matchedSignals.push('KDJ金叉');
  if (indicators?.macdSignal === 'golden') matchedSignals.push('MACD金叉');

  let score = 38
    + Math.min(14, Math.max(-12, change * 2.5))
    + Math.min(10, Math.log10(Math.max(1, amount)) * 5)
    + Math.min(8, turnover)
    + Math.min(8, Math.max(0, volumeRatio - 0.6) * 6)
    + (amplitude > 0 && amplitude <= 6 ? 3 : 0);
  if (indicators) {
    score += indicators.trend === 'bullish' ? 10 : indicators.trend === 'aboveMa20' ? 5 : indicators.trend === 'bearish' ? -8 : 0;
    score += Math.min(8, Math.max(-8, indicators.return20d / 2));
    score += indicators.rsi14 >= 45 && indicators.rsi14 <= 75 ? 4 : indicators.rsi14 > 85 ? -4 : 0;
    score += indicators.kdjSignal === 'golden' ? 3 : indicators.kdjSignal === 'death' ? -3 : 0;
    score += indicators.macdSignal === 'golden' ? 4 : indicators.macdSignal === 'death' ? -4 : 0;
  }
  return { technicalScore: Math.round(Math.min(100, Math.max(0, score))), matchedSignals };
}

export function prefilterMarketTechnicalRows(
  rows: MarketTechnicalRow[],
  criteria: MarketTechnicalScreenCriteria,
  poolLimit: number,
): MarketTechnicalCandidate[] {
  return rows
    .filter((row) => criteria.markets.includes(row.market))
    .filter((row) => !criteria.excludeRiskNames || !/(?:ST|退)/i.test(row.name))
    .filter((row) => row.changePct != null && row.changePct >= criteria.minChangePct && row.changePct <= criteria.maxChangePct)
    .filter((row) => row.amountYi != null && row.amountYi >= criteria.minAmountYi)
    .filter((row) => criteria.minTurnoverPct <= 0 || (row.turnoverPct != null && row.turnoverPct >= criteria.minTurnoverPct))
    .filter((row) => criteria.minVolumeRatio <= 0 || (row.volumeRatio != null && row.volumeRatio >= criteria.minVolumeRatio))
    .filter((row) => criteria.maxAmplitudePct <= 0 || (row.amplitudePct != null && row.amplitudePct <= criteria.maxAmplitudePct))
    .map((row) => ({ ...row, ...candidateScore(row), indicators: null }))
    .sort((a, b) => b.technicalScore - a.technicalScore || finiteOr(b.amountYi, 0) - finiteOr(a.amountYi, 0))
    .slice(0, poolLimit);
}

function returnForPeriod(indicators: HistoricalTechnicalIndicators, period: 5 | 10 | 20): number {
  if (period === 5) return indicators.return5d;
  if (period === 10) return indicators.return10d;
  return indicators.return20d;
}

export function filterEnrichedCandidates(
  candidates: MarketTechnicalCandidate[],
  criteria: MarketTechnicalScreenCriteria,
): MarketTechnicalCandidate[] {
  return candidates
    .filter((candidate) => {
      const value = candidate.indicators;
      const needsIndicators = criteria.trend !== 'any'
        || criteria.minPeriodReturn > -30
        || criteria.maxPeriodReturn < 30
        || criteria.streakDirection !== 'any'
        || criteria.minRsi > 0
        || criteria.maxRsi < 100
        || criteria.kdjSignal !== 'any'
        || criteria.macdSignal !== 'any';
      if (!value) return !needsIndicators;
      const selectedReturn = returnForPeriod(value, criteria.returnPeriod);
      if (selectedReturn < criteria.minPeriodReturn || selectedReturn > criteria.maxPeriodReturn) return false;
      if (criteria.trend === 'bullish' && value.trend !== 'bullish') return false;
      if (criteria.trend === 'aboveMa20' && !['bullish', 'aboveMa20'].includes(value.trend)) return false;
      if (criteria.trend === 'bearish' && value.trend !== 'bearish') return false;
      if (criteria.streakDirection === 'up' && value.streak < criteria.minStreakDays) return false;
      if (criteria.streakDirection === 'down' && value.streak > -criteria.minStreakDays) return false;
      if (value.rsi14 < criteria.minRsi || value.rsi14 > criteria.maxRsi) return false;
      if (criteria.kdjSignal !== 'any' && value.kdjSignal !== criteria.kdjSignal) return false;
      if (criteria.macdSignal !== 'any' && value.macdSignal !== criteria.macdSignal) return false;
      return true;
    })
    .map((candidate) => ({ ...candidate, ...candidateScore(candidate, candidate.indicators) }))
    .sort((a, b) => b.technicalScore - a.technicalScore)
    .slice(0, criteria.limit);
}

export function screenMarketTechnicalRows(
  rows: MarketTechnicalRow[],
  criteria: MarketTechnicalScreenCriteria,
): MarketTechnicalCandidate[] {
  return filterEnrichedCandidates(prefilterMarketTechnicalRows(rows, criteria, criteria.limit), criteria);
}
