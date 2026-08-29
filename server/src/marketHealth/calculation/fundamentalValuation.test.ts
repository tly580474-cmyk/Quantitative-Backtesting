import { describe, expect, it } from 'vitest';
import {
  calculateFundamentalAndValuation,
  calculateFundamentalAndValuationSeries,
  type FundamentalValuationRawPoint,
} from './fundamentalValuation.js';

function points(count = 260, coverage = 90): FundamentalValuationRawPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    tradeDate: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    eligibleStocks: 5000,
    roeCoveragePct: coverage,
    growthCoveragePct: coverage,
    peCoveragePct: coverage,
    pbCoveragePct: coverage,
    latestReportPeriod: '2026-06-30',
    latestAnnouncementDate: '2026-08-20',
    aggregateRoe: 8 + index * 0.01,
    positiveRoeBreadth: 60 + index * 0.01,
    improvingRoeBreadth: 45 + index * 0.01,
    aggregateProfitGrowth: -0.1 + index * 0.001,
    improvingProfitBreadth: 40 + index * 0.02,
    improvingRevenueBreadth: 42 + index * 0.02,
    aggregatePe: 12 + index * 0.02,
    aggregatePb: 1.2 + index * 0.002,
  }));
}

describe('fundamental health and valuation pressure', () => {
  it('keeps the frozen top-level weights and direction semantics', () => {
    const result = calculateFundamentalAndValuation(points(), 'snapshot-1', new Date('2026-08-29T00:00:00Z'));
    expect(result.fhi?.components.map((item) => item.weight)).toEqual([0.5, 0.5]);
    expect(result.vpi?.components.map((item) => item.weight)).toEqual([0.5, 0.5]);
    expect(result.fhi?.direction).toBe('higher_is_better');
    expect(result.vpi?.direction).toBe('higher_is_riskier');
    expect(result.fhi?.periodKey).toBe('2026Q2');
  });

  it('publishes intermediate coverage as preliminary', () => {
    const result = calculateFundamentalAndValuation(points(260, 60), 'snapshot-1');
    expect(result.fhi?.publicationStatus).toBe('preliminary');
    expect(result.vpi?.publicationStatus).toBe('preliminary');
  });

  it('rejects insufficient coverage and causal history', () => {
    expect(calculateFundamentalAndValuation(points(260, 20), 'snapshot-1')).toEqual({ fhi: null, vpi: null });
    expect(calculateFundamentalAndValuation(points(252), 'snapshot-1')).toEqual({ fhi: null, vpi: null });
  });

  it('builds a causal historical series from the same frozen formula', () => {
    const result = calculateFundamentalAndValuationSeries(points(270), 'snapshot-1');
    expect(result.fhi).toHaveLength(18);
    expect(result.vpi).toHaveLength(18);
    expect(result.fhi[0].asOfDate).toBe(points(270)[252].tradeDate);
    expect(result.vpi.at(-1)?.direction).toBe('higher_is_riskier');
  });
});
