import type { MarketHealthSnapshotInput } from '../types.js';
import { quantile, robustGoodScore } from './scoring.js';

const MIN_HISTORY = 252;
const MAX_HISTORY = 756;

export interface MarketStructureRawPoint {
  tradeDate: string;
  eligibleStocks: number;
  availableIndices: number;
  availableIndustries: number;
  indexReturn20d: number | null;
  indexReturn60d: number | null;
  indexTrendAlignment: number | null;
  pctAboveMa20: number | null;
  pctAboveMa60: number | null;
  pctIndustriesAboveMa60: number | null;
  downsideSemivol20d: number | null;
  drawdownMagnitude60d: number | null;
  downsideComovement20d: number | null;
  medianAmihud20d: number | null;
  liquidityDroughtFraction: number | null;
  turnoverTop5PctShare: number | null;
}

export function calculateMarketStructure(
  points: MarketStructureRawPoint[],
  sourceSnapshotId: string,
  calculatedAt = new Date(),
): MarketHealthSnapshotInput | null {
  const ordered = [...points].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  if (ordered.length <= MIN_HISTORY) return null;
  const current = ordered.at(-1)!;
  const history = ordered.slice(Math.max(0, ordered.length - 1 - MAX_HISTORY), -1);
  if (history.length < MIN_HISTORY || current.availableIndices < 4 || current.pctIndustriesAboveMa60 == null) {
    return null;
  }

  const trend20 = good(current, history, 'indexReturn20d');
  const trend60 = good(current, history, 'indexReturn60d');
  const trendAlignment = clamp100((current.indexTrendAlignment ?? Number.NaN) * 100);
  const breadth20 = clamp100(current.pctAboveMa20 ?? Number.NaN);
  const breadth60 = clamp100(current.pctAboveMa60 ?? Number.NaN);
  const industryBreadth = clamp100(current.pctIndustriesAboveMa60);
  const semivol = bad(current, history, 'downsideSemivol20d');
  const drawdown = bad(current, history, 'drawdownMagnitude60d');
  const comovement = bad(current, history, 'downsideComovement20d');
  const amihud = bad(current, history, 'medianAmihud20d');
  const drought = bad(current, history, 'liquidityDroughtFraction');
  const concentration = bad(current, history, 'turnoverTop5PctShare');
  const values = [trend20, trend60, trendAlignment, breadth20, breadth60, industryBreadth,
    semivol, drawdown, comovement, amihud, drought, concentration];
  if (values.some((value) => value == null)) return null;

  const trend = (trend20! + trend60! + trendAlignment!) / 3;
  const participation = 0.4 * breadth20! + 0.4 * breadth60! + 0.2 * industryBreadth!;
  const risk = 0.4 * semivol! + (1 / 3) * drawdown! + (4 / 15) * comovement!;
  const liquidity = (8 / 15) * amihud! + (4 / 15) * drought! + (3 / 15) * concentration!;
  const score = 0.3 * trend + 0.25 * participation + 0.3 * risk + 0.15 * liquidity;
  const medianEligible = quantile(history.map((row) => row.eligibleStocks), 0.5) ?? current.eligibleStocks;
  const stockCoverage = medianEligible > 0 ? Math.min(100, 100 * current.eligibleStocks / medianEligible) : 0;
  const indexCoverage = Math.min(100, 100 * current.availableIndices / 5);
  const coverage = Math.min(stockCoverage, indexCoverage);
  if (coverage < 60) return null;
  const status = marketStructureStatus(score);
  return {
    indicatorKey: 'msh',
    asOfDate: current.tradeDate,
    periodKey: current.tradeDate,
    score,
    statusLabel: status.label,
    interpretation: status.interpretation,
    direction: 'higher_is_better',
    frequency: 'daily',
    modelVersion: 'msh-v1',
    components: [
      { key: 'trend', label: '趋势结构', value: current.indexReturn20d, score: trend, weight: 0.3, source: 'market', description: '核心指数20/60日收益与均线趋势一致性。' },
      { key: 'participation', label: '市场参与度', value: current.pctAboveMa20, score: participation, weight: 0.25, source: 'market', description: '个股20/60日均线广度与行业60日均线广度。' },
      { key: 'risk', label: '下行风险', value: current.downsideSemivol20d, score: risk, weight: 0.3, source: 'market', description: '下行半波动、60日回撤和下跌共振的反向得分。' },
      { key: 'liquidity', label: '流动性结构', value: current.medianAmihud20d, score: liquidity, weight: 0.15, source: 'market', description: '非流动性、缩量股票占比和成交集中度的反向得分。' },
    ],
    sourcePeriods: {
      marketDate: current.tradeDate,
      eligibleStocks: current.eligibleStocks,
      availableIndices: current.availableIndices,
      availableIndustries: current.availableIndustries,
    },
    coveragePct: coverage,
    sourceSnapshotId,
    calculatedAt: calculatedAt.toISOString(),
    publicationStatus: coverage >= 80 ? 'published' : 'preliminary',
    staleAfter: addUtcDays(current.tradeDate, 7),
  };
}

function good(current: MarketStructureRawPoint, history: MarketStructureRawPoint[], key: keyof MarketStructureRawPoint) {
  const value = current[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return robustGoodScore(value, numericHistory(history, key));
}

function bad(current: MarketStructureRawPoint, history: MarketStructureRawPoint[], key: keyof MarketStructureRawPoint) {
  const result = good(current, history, key);
  return result == null ? null : 100 - result;
}

function numericHistory(rows: MarketStructureRawPoint[], key: keyof MarketStructureRawPoint): number[] {
  return rows.map((row) => row[key]).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

function clamp100(value: number): number | null {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
}

function marketStructureStatus(score: number): { label: string; interpretation: string } {
  if (score >= 80) return { label: '结构稳健', interpretation: '趋势、参与度、下行风险和流动性结构多数处于有利状态。' };
  if (score >= 60) return { label: '结构偏强', interpretation: '市场内部结构总体稳定，但仍需结合盈利和估值轴确认持续性。' };
  if (score >= 40) return { label: '结构中性', interpretation: '市场内部强弱因素并存，暂未形成一致的结构信号。' };
  if (score >= 20) return { label: '结构偏弱', interpretation: '趋势、广度或风险结构出现弱化，需关注后续回撤压力。' };
  return { label: '结构脆弱', interpretation: '市场内部结构显著承压，风险释放尚未得到充分确认。' };
}
