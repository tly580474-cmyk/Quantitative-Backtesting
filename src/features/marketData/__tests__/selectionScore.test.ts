import { describe, expect, it } from 'vitest';
import { calculateSelectionScore } from '../selectionScore';
import type { KlinePoint } from '../types';

function makeSeries(
  count: number,
  closeAt: (index: number) => number,
  volumeAt: (index: number) => number = () => 1_000_000,
  bearishBody = false,
): KlinePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    const open = bearishBody ? close * 1.04 : close * 0.997;
    return {
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      open,
      close,
      high: Math.max(open, close) * 1.006,
      low: Math.min(open, close) * 0.994,
      volume: volumeAt(index),
    };
  });
}

describe('stock selection score', () => {
  it('requires enough daily candles for the 60-day trend', () => {
    const result = calculateSelectionScore(makeSeries(40, (index) => 100 + index), []);

    expect(result).toMatchObject({
      status: 'insufficient',
      score: null,
      sampleSize: 40,
    });
  });

  it('keeps the normalized score within 0-100 and exposes all seven sections', () => {
    const stock = makeSeries(
      100,
      (index) => 100 + index * 0.35 + Math.sin(index / 2) * 1.8,
      (index) => 800_000 + index * 8_000,
    );
    const benchmark = makeSeries(100, (index) => 100 + index * 0.05);
    const result = calculateSelectionScore(stock, benchmark);

    expect(result.status).toBe('ready');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.sections.map((item) => item.key)).toEqual([
      'trend',
      'momentum',
      'volume',
      'support',
      'pattern',
      'oscillator',
      'volatility',
      'risk',
    ]);
    expect(result.normalizedBaseScore).toBe(
      result.rawPositiveScore,
    );
  });

  it('penalizes bearish alignment, consecutive large bearish candles, and weak liquidity', () => {
    const bearish = makeSeries(
      100,
      (index) => 240 - index * 1.6,
      () => 1_000,
      true,
    );
    const benchmark = makeSeries(100, (index) => 100 + index * 0.05);
    const result = calculateSelectionScore(bearish, benchmark);
    const risk = result.sections.find((item) => item.key === 'risk');

    expect(result.status).toBe('ready');
    expect(result.tier).toBe('blocked');
    expect(result.riskDeduction).toBeGreaterThanOrEqual(29);
    expect(risk?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '均线明显空头排列', matched: true, points: -10 }),
      expect.objectContaining({ label: '短期连续大阴线且无企稳', matched: true, points: -6 }),
      expect.objectContaining({ label: '日均成交额低于 3000 万', matched: true, points: -5 }),
    ]));
  });
});
