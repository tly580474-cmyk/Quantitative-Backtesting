import { describe, expect, it } from 'vitest';
import { calculateSelectionScore } from '../selectionScore';
import type { KlinePoint } from '../types';

function makeSeries(
  count: number,
  closeAt: (index: number) => number,
  volumeAt: (index: number) => number = () => 1_000_000,
  turnoverAt: (index: number) => number | undefined = () => 1,
): KlinePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    return {
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      open: close * 0.997,
      close,
      high: close * 1.006,
      low: close * 0.994,
      volume: volumeAt(index),
      amount: 100_000_000,
      turnoverRatePct: turnoverAt(index),
    };
  });
}

describe('data-driven stock selection score', () => {
  it('requires enough cleaned daily candles for the longest factor', () => {
    const source = makeSeries(64, (index) => 100 + index);
    source.push({ ...source[0] });
    source[1] = { ...source[1], close: 0 };
    const result = calculateSelectionScore(source, []);

    expect(result).toMatchObject({
      status: 'insufficient',
      score: null,
      inputSampleSize: 65,
      sampleSize: 63,
    });
    expect(result.message).toContain('收到 65 根');
    expect(result.message).toContain('63 根有效日 K');
  });

  it('returns a bounded weighted percentile and the research factor groups', () => {
    const stock = makeSeries(
      180,
      (index) => 100 + Math.sin(index / 7) * 4 + index * 0.02,
      (index) => 900_000 + Math.sin(index / 5) * 150_000,
      (index) => 1.5 + Math.sin(index / 9) * 0.5,
    );
    const result = calculateSelectionScore(stock, []);

    expect(result.status).toBe('ready');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.sections.map((item) => item.key)).toEqual([
      'volume',
      'trend',
      'momentum',
      'pattern',
      'liquidity',
      'risk',
    ]);
    expect(result.sections.flatMap((item) => item.items).map((item) => item.label))
      .toEqual(expect.arrayContaining([
        '20 日突破强度',
        '3 日 / 20 日均量比',
        '换手率',
        'RSI(14)',
        '20 日收益率',
        '近 5 日 / 前 15 日波幅比',
        '当日量比',
        'MA60 5 日斜率',
        '价格相对 MA20 距离',
      ]));
    expect(result.normalizedBaseScore).toBe(result.rawPositiveScore);
    expect(result.assumptions[0]).toContain('PB');
  });

  it('reverses the old trend and momentum preference', () => {
    const rising = makeSeries(180, (index) => (
      index < 150 ? 100 + Math.sin(index / 5) : 100 + (index - 149) * 1.2
    ));
    const falling = makeSeries(180, (index) => (
      index < 150 ? 100 + Math.sin(index / 5) : 100 - (index - 149) * 0.8
    ));

    const risingResult = calculateSelectionScore(rising, []);
    const fallingResult = calculateSelectionScore(falling, []);

    expect(risingResult.status).toBe('ready');
    expect(fallingResult.status).toBe('ready');
    expect(fallingResult.score).toBeGreaterThan(risingResult.score!);
    expect(fallingResult.sections.find((item) => item.key === 'trend')!.score)
      .toBeGreaterThan(risingResult.sections.find((item) => item.key === 'trend')!.score);
    expect(fallingResult.sections.find((item) => item.key === 'momentum')!.score)
      .toBeGreaterThan(risingResult.sections.find((item) => item.key === 'momentum')!.score);
  });

  it('scores a high-volume breakout below a quiet pullback', () => {
    const baseClose = (index: number) => 100 + Math.sin(index / 4) * 2;
    const breakout = makeSeries(
      180,
      (index) => index === 179 ? 118 : baseClose(index),
      (index) => index === 179 ? 8_000_000 : 1_000_000,
    );
    const pullback = makeSeries(
      180,
      (index) => index === 179 ? 94 : baseClose(index),
      (index) => index === 179 ? 250_000 : 1_000_000,
    );

    const breakoutResult = calculateSelectionScore(breakout, []);
    const pullbackResult = calculateSelectionScore(pullback, []);

    expect(pullbackResult.sections.find((item) => item.key === 'volume')!.score)
      .toBeGreaterThan(breakoutResult.sections.find((item) => item.key === 'volume')!.score);
    expect(pullbackResult.score).toBeGreaterThan(breakoutResult.score!);
  });

  it('uses real traded amount for the liquidity hard filter', () => {
    const liquid = makeSeries(180, (index) => 10 + Math.sin(index / 6))
      .map((item) => ({ ...item, volume: 1_000, amount: 50_000_000 }));
    const illiquid = liquid.map((item) => ({ ...item, amount: 5_000_000 }));

    const liquidResult = calculateSelectionScore(liquid, []);
    const illiquidResult = calculateSelectionScore(illiquid, []);

    expect(liquidResult.forcedCooling).toBe(false);
    expect(illiquidResult.forcedCooling).toBe(true);
    expect(illiquidResult.tier).toBe('blocked');
    expect(illiquidResult.score).toBeLessThanOrEqual(39);
    expect(illiquidResult.sections.find((entry) => entry.key === 'risk')?.items[0])
      .toMatchObject({ matched: true });
    expect(liquidResult.assumptions).toContain('流动性硬过滤使用历史 K 线提供的真实成交额。');
  });

  it('renormalizes weights when turnover history is unavailable', () => {
    const stock = makeSeries(
      180,
      (index) => 100 + Math.sin(index / 7) * 3,
      undefined,
      () => undefined,
    );
    const result = calculateSelectionScore(stock, []);

    expect(result.status).toBe('ready');
    expect(result.sections.some((item) => item.key === 'liquidity')).toBe(false);
    expect(result.assumptions.some((item) => item.includes('换手率'))).toBe(true);
    const totalMax = result.sections.reduce((sum, item) => sum + (item.maxScore ?? 0), 0);
    expect(totalMax).toBeCloseTo(100, 0);
  });
});
