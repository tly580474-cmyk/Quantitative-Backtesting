import type { MarketHealthSnapshotInput } from '../types.js';
import { robustGoodScore } from './scoring.js';

const MIN_HISTORY = 252;
const MAX_HISTORY = 756;
const MIN_FHI_COVERAGE = 30;
const MIN_VPI_COVERAGE = 50;
const PUBLISHED_FHI_COVERAGE = 85;
// 近 900 个交易日正 PE 覆盖率约为 71%～79%；70% 能识别异常骤降，
// 同时不会把亏损公司天然导致的非正 PE 误判为数据缺失。
const PUBLISHED_VPI_COVERAGE = 70;

export interface FundamentalValuationRawPoint {
  tradeDate: string;
  eligibleStocks: number;
  roeCoveragePct: number | null;
  growthCoveragePct: number | null;
  peCoveragePct: number | null;
  pbCoveragePct: number | null;
  latestReportPeriod: string | null;
  latestAnnouncementDate: string | null;
  aggregateRoe: number | null;
  positiveRoeBreadth: number | null;
  improvingRoeBreadth: number | null;
  aggregateProfitGrowth: number | null;
  improvingProfitBreadth: number | null;
  improvingRevenueBreadth: number | null;
  aggregatePe: number | null;
  aggregatePb: number | null;
}

export function calculateFundamentalAndValuation(
  points: FundamentalValuationRawPoint[],
  sourceSnapshotId: string,
  calculatedAt = new Date(),
): { fhi: MarketHealthSnapshotInput | null; vpi: MarketHealthSnapshotInput | null } {
  const ordered = [...points].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  if (ordered.length <= MIN_HISTORY) return { fhi: null, vpi: null };
  const current = ordered.at(-1)!;
  const history = ordered.slice(Math.max(0, ordered.length - 1 - MAX_HISTORY), -1);
  if (history.length < MIN_HISTORY) return { fhi: null, vpi: null };
  return {
    fhi: calculateFhi(current, history, sourceSnapshotId, calculatedAt),
    vpi: calculateVpi(current, history, sourceSnapshotId, calculatedAt),
  };
}

function calculateFhi(
  current: FundamentalValuationRawPoint,
  history: FundamentalValuationRawPoint[],
  sourceSnapshotId: string,
  calculatedAt: Date,
): MarketHealthSnapshotInput | null {
  const coverage = Math.min(current.roeCoveragePct ?? 0, current.growthCoveragePct ?? 0);
  if (coverage < MIN_FHI_COVERAGE) return null;
  const roe = score(current, history, 'aggregateRoe');
  const improvingRoe = score(current, history, 'improvingRoeBreadth');
  const positiveRoe = score(current, history, 'positiveRoeBreadth');
  const profitGrowth = score(current, history, 'aggregateProfitGrowth');
  const improvingProfit = score(current, history, 'improvingProfitBreadth');
  const improvingRevenue = score(current, history, 'improvingRevenueBreadth');
  if ([roe, improvingRoe, positiveRoe, profitGrowth, improvingProfit, improvingRevenue]
    .some((value) => value == null)) return null;
  const profitability = 0.5 * roe! + 0.25 * improvingRoe! + 0.25 * positiveRoe!;
  const growth = 0.5 * profitGrowth! + 0.3 * improvingProfit! + 0.2 * improvingRevenue!;
  const scoreValue = 0.5 * profitability + 0.5 * growth;
  const status = fhiStatus(scoreValue);
  return {
    indicatorKey: 'fhi',
    asOfDate: current.tradeDate,
    periodKey: reportQuarter(current.latestReportPeriod) ?? current.tradeDate.slice(0, 7),
    score: scoreValue,
    statusLabel: status.label,
    interpretation: status.interpretation,
    direction: 'higher_is_better',
    frequency: 'event',
    modelVersion: 'fhi-v1',
    components: [
      { key: 'profitability', label: '盈利能力', value: current.aggregateRoe, score: profitability, weight: 0.5, source: 'financial', description: '总量ROE、ROE改善扩散度与正ROE公司占比。' },
      { key: 'earnings_growth', label: '盈利增长', value: current.aggregateProfitGrowth, score: growth, weight: 0.5, source: 'financial', description: '利润总量增速、利润改善扩散度与收入改善扩散度。' },
    ],
    sourcePeriods: {
      marketDate: current.tradeDate,
      latestReportPeriod: current.latestReportPeriod,
      latestAnnouncementDate: current.latestAnnouncementDate,
      roeCoveragePct: current.roeCoveragePct,
      growthCoveragePct: current.growthCoveragePct,
    },
    coveragePct: coverage,
    sourceSnapshotId,
    calculatedAt: calculatedAt.toISOString(),
    publicationStatus: coverage >= PUBLISHED_FHI_COVERAGE ? 'published' : 'preliminary',
    staleAfter: addUtcDays(current.tradeDate, 140),
  };
}

function calculateVpi(
  current: FundamentalValuationRawPoint,
  history: FundamentalValuationRawPoint[],
  sourceSnapshotId: string,
  calculatedAt: Date,
): MarketHealthSnapshotInput | null {
  const coverage = Math.min(current.peCoveragePct ?? 0, current.pbCoveragePct ?? 0);
  if (coverage < MIN_VPI_COVERAGE) return null;
  const pe = score(current, history, 'aggregatePe');
  const pb = score(current, history, 'aggregatePb');
  if (pe == null || pb == null) return null;
  const scoreValue = 0.5 * pe + 0.5 * pb;
  const status = vpiStatus(scoreValue);
  return {
    indicatorKey: 'vpi',
    asOfDate: current.tradeDate,
    periodKey: current.tradeDate,
    score: scoreValue,
    statusLabel: status.label,
    interpretation: status.interpretation,
    direction: 'higher_is_riskier',
    frequency: 'daily',
    modelVersion: 'vpi-v1',
    components: [
      { key: 'pe_pressure', label: 'PE压力', value: current.aggregatePe, score: pe, weight: 0.5, source: 'market', description: '总市值加权聚合PE相对自身历史分布的压力。' },
      { key: 'pb_pressure', label: 'PB压力', value: current.aggregatePb, score: pb, weight: 0.5, source: 'market', description: '总市值加权聚合PB相对自身历史分布的压力。' },
    ],
    sourcePeriods: {
      marketDate: current.tradeDate,
      peCoveragePct: current.peCoveragePct,
      pbCoveragePct: current.pbCoveragePct,
    },
    coveragePct: coverage,
    sourceSnapshotId,
    calculatedAt: calculatedAt.toISOString(),
    publicationStatus: coverage >= PUBLISHED_VPI_COVERAGE ? 'published' : 'preliminary',
    staleAfter: addUtcDays(current.tradeDate, 7),
  };
}

function score(
  current: FundamentalValuationRawPoint,
  history: FundamentalValuationRawPoint[],
  key: keyof FundamentalValuationRawPoint,
): number | null {
  const value = current[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return robustGoodScore(value, history.map((row) => row[key]).filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item),
  ));
}

function reportQuarter(period: string | null): string | null {
  if (!period || !/^\d{4}-\d{2}/.test(period)) return null;
  const month = Number(period.slice(5, 7));
  return `${period.slice(0, 4)}Q${Math.ceil(month / 3)}`;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
}

function fhiStatus(score: number): { label: string; interpretation: string } {
  if (score >= 80) return { label: '盈利承载强', interpretation: '已披露盈利能力和增长扩散度均处于历史高位，但不等同于短期价格安全。' };
  if (score >= 60) return { label: '盈利承载偏强', interpretation: '已披露盈利对市场具备一定支撑，仍需结合估值压力和名义周期判断。' };
  if (score >= 40) return { label: '盈利承载中性', interpretation: '盈利能力和增长大致处于历史中枢，基本面方向尚不鲜明。' };
  if (score >= 20) return { label: '盈利承载偏弱', interpretation: '盈利能力或增长扩散度偏弱，市场上涨可能缺少基本面确认。' };
  return { label: '盈利承载弱', interpretation: '已披露盈利显著承压，需要警惕盈利下修和结构性风险。' };
}

function vpiStatus(score: number): { label: string; interpretation: string } {
  if (score >= 80) return { label: '估值压力高', interpretation: 'PE与PB均处于自身历史高位，长期回报空间可能受到估值约束。' };
  if (score >= 60) return { label: '估值压力偏高', interpretation: '市场估值高于历史中枢，需要更强盈利兑现来消化溢价。' };
  if (score >= 40) return { label: '估值压力中性', interpretation: '聚合估值接近自身历史中枢，尚无明显便宜或昂贵信号。' };
  if (score >= 20) return { label: '估值压力偏低', interpretation: '聚合估值低于历史中枢，但低估值本身不构成趋势反转信号。' };
  return { label: '估值压力低', interpretation: 'PE与PB处于历史低位，安全边际改善但仍需基本面和市场结构确认。' };
}
