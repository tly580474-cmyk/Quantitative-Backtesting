import { describe, expect, it } from 'vitest';
import type { Instrument, KlinePoint } from '@/features/marketData/types';
import {
  eligibleDecisionIndices,
  hasTrainingLiquidity,
  reconstructQfqFromPreviousClose,
  toTrainingCandidate,
} from './universe';

function instrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: '1', market: 'SH', symbol: '600000', name: '浦发银行', type: 'stock',
    status: 'active', createdAt: '', updatedAt: '', ...overrides,
  };
}

function bars(count: number, amount = 20_000_000): KlinePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2015, 0, 1 + index));
    return {
      date: date.toISOString().slice(0, 10),
      open: 10, high: 10.5, low: 9.5, close: 10, volume: 2_000_000, amount,
    };
  });
}

describe('training universe', () => {
  it('keeps only active non-risk Shanghai and Shenzhen stocks', () => {
    expect(toTrainingCandidate(instrument())).toMatchObject({ code: '600000', market: '沪市' });
    expect(toTrainingCandidate(instrument({ market: 'BJ', symbol: '920001' }))).toBeNull();
    expect(toTrainingCandidate(instrument({ name: '*ST测试' }))).toBeNull();
    expect(toTrainingCandidate(instrument({ name: 'SST测试' }))).toBeNull();
    expect(toTrainingCandidate(instrument({ name: '退市测试' }))).toBeNull();
    expect(toTrainingCandidate(instrument({ status: 'delisted' }))).toBeNull();
    expect(toTrainingCandidate(instrument({ delistDate: '2024-01-01' }))).toBeNull();
  });

  it('rejects windows with extremely low turnover', () => {
    expect(hasTrainingLiquidity(bars(20), 19)).toBe(true);
    expect(hasTrainingLiquidity(bars(20, 2_000_000), 19)).toBe(false);
  });

  it('returns decision points with enough context, future bars, and liquidity', () => {
    const points = eligibleDecisionIndices(bars(500), 80, 50, '2020-01-01');
    expect(points[0]).toBe(79);
    expect(points[points.length - 1]).toBe(449);
  });

  it('reconstructs a continuous forward-adjusted series from the official previous close', () => {
    const input = bars(3);
    input[0] = { ...input[0], open: 100, high: 102, low: 98, close: 100 };
    input[1] = { ...input[1], open: 50, high: 52, low: 49, close: 51, previousClose: 50 };
    input[2] = { ...input[2], open: 51, high: 53, low: 50, close: 52, previousClose: 51 };
    const adjusted = reconstructQfqFromPreviousClose(input);
    expect(adjusted[0].close).toBe(50);
    expect(adjusted[1].close).toBe(51);
    expect(adjusted[2].close).toBe(52);
  });
});
