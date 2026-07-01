import type { MarketTechnicalRow } from './aStockDataService.js';

export interface MarketTechnicalScreenCriteria {
  markets: Array<'SH' | 'SZ' | 'BJ'>;
  minChangePct: number;
  maxChangePct: number;
  minAmountYi: number;
  minTurnoverPct: number;
  minVolumeRatio: number;
  maxAmplitudePct: number;
  excludeRiskNames: boolean;
  limit: number;
}

export interface MarketTechnicalCandidate extends MarketTechnicalRow {
  technicalScore: number;
  matchedSignals: string[];
}

function finiteOr(value: number | null, fallback: number): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

function candidateScore(row: MarketTechnicalRow): Pick<MarketTechnicalCandidate, 'technicalScore' | 'matchedSignals'> {
  const change = finiteOr(row.changePct, 0);
  const amount = finiteOr(row.amountYi, 0);
  const turnover = finiteOr(row.turnoverPct, 0);
  const volumeRatio = finiteOr(row.volumeRatio, 0);
  const amplitude = finiteOr(row.amplitudePct, 0);
  const matchedSignals: string[] = [];
  if (change > 0) matchedSignals.push('收涨');
  if (change >= 2) matchedSignals.push('动量增强');
  if (amount >= 5) matchedSignals.push('成交活跃');
  if (turnover >= 2) matchedSignals.push('换手充分');
  if (volumeRatio >= 1.2) matchedSignals.push('量能放大');
  if (amplitude > 0 && amplitude <= 6) matchedSignals.push('波动适中');

  const score = 45
    + Math.min(18, Math.max(-15, change * 3))
    + Math.min(12, Math.log10(Math.max(1, amount)) * 6)
    + Math.min(10, turnover * 1.5)
    + Math.min(10, Math.max(0, volumeRatio - 0.6) * 8)
    + (amplitude > 0 && amplitude <= 6 ? 5 : 0);
  return { technicalScore: Math.round(Math.min(100, Math.max(0, score))), matchedSignals };
}

export function screenMarketTechnicalRows(
  rows: MarketTechnicalRow[],
  criteria: MarketTechnicalScreenCriteria,
): MarketTechnicalCandidate[] {
  return rows
    .filter((row) => criteria.markets.includes(row.market))
    .filter((row) => !criteria.excludeRiskNames || !/(?:ST|退)/i.test(row.name))
    .filter((row) => row.changePct != null && row.changePct >= criteria.minChangePct && row.changePct <= criteria.maxChangePct)
    .filter((row) => row.amountYi != null && row.amountYi >= criteria.minAmountYi)
    .filter((row) => criteria.minTurnoverPct <= 0 || (row.turnoverPct != null && row.turnoverPct >= criteria.minTurnoverPct))
    .filter((row) => criteria.minVolumeRatio <= 0 || (row.volumeRatio != null && row.volumeRatio >= criteria.minVolumeRatio))
    .filter((row) => criteria.maxAmplitudePct <= 0 || (row.amplitudePct != null && row.amplitudePct <= criteria.maxAmplitudePct))
    .map((row) => ({ ...row, ...candidateScore(row) }))
    .sort((a, b) => b.technicalScore - a.technicalScore || finiteOr(b.amountYi, 0) - finiteOr(a.amountYi, 0))
    .slice(0, criteria.limit);
}
