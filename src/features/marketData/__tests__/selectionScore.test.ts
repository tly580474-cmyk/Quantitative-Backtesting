import { describe, expect, it } from 'vitest';
import { calculateSelectionScore, limitUpThreshold, SELECTION_STYLE_OPTIONS } from '../selectionScore';
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

describe('multi-style stock selection score', () => {
  it('publishes five styles with research-backed holding horizons', () => {
    expect(SELECTION_STYLE_OPTIONS.map((item) => [item.value, item.horizon])).toEqual([
      ['value', 60],
      ['growth', 60],
      ['contrarian', 20],
      ['trend', 60],
      ['limit-up', 10],
    ]);
  });

  it('uses board-specific limit-up thresholds', () => {
    expect(limitUpThreshold('600000')).toBe(0.095);
    expect(limitUpThreshold('300001')).toBe(0.195);
    expect(limitUpThreshold('688001')).toBe(0.195);
    expect(limitUpThreshold('830001')).toBe(0.295);
    expect(limitUpThreshold('920001')).toBe(0.295);
  });

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

  it('returns a bounded contrarian score and explicitly includes benchmark comparison', () => {
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
      'market',
      'trend',
      'momentum',
      'volume',
      'pattern',
      'liquidity',
      'risk',
    ]);
    expect(result.sections.flatMap((item) => item.items).map((item) => item.label))
      .toEqual(expect.arrayContaining([
        '20 日突破强度',
        '换手率',
        'RSI(14)',
        '20 日收益率',
        '近5日/前15日波幅',
        '相对沪深300 20日强弱',
        '当日量比',
        'MA60 5日斜率',
        '价格相对 MA20',
      ]));
    expect(result.normalizedBaseScore).toBe(result.rawPositiveScore);
    expect(result.assumptions.some((item) => item.includes('沪深300'))).toBe(true);
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

  it('uses the same market move to distinguish stock relative strength in every style', () => {
    const benchmark = makeSeries(180, (index) => 100 + index * 0.2);
    const strong = makeSeries(180, (index) => 100 + index * 0.45);
    const weak = makeSeries(180, (index) => 100 + index * 0.05);

    for (const style of ['value', 'growth', 'trend', 'limit-up'] as const) {
      const strongResult = calculateSelectionScore(strong, benchmark, style);
      const weakResult = calculateSelectionScore(weak, benchmark, style);
      expect(strongResult.relativeStrength20d).toBeGreaterThan(0);
      expect(weakResult.relativeStrength20d).toBeLessThan(0);
      expect(strongResult.sections.find((item) => item.key === 'market')!.score)
        .toBeGreaterThan(weakResult.sections.find((item) => item.key === 'market')!.score);
    }

    const contrarianStrong = calculateSelectionScore(strong, benchmark, 'contrarian');
    const contrarianWeak = calculateSelectionScore(weak, benchmark, 'contrarian');
    expect(contrarianWeak.sections.find((item) => item.key === 'market')!.score)
      .toBeGreaterThan(contrarianStrong.sections.find((item) => item.key === 'market')!.score);
  });

  it('uses a shorter recent benchmark history for a long-listed stock', () => {
    const stock = makeSeries(600, (index) => 100 + index * 0.1);
    const benchmark = stock.slice(-120).map((item, index) => ({
      ...item,
      close: 100 + index * 0.05,
      open: 100 + index * 0.05,
      high: 101 + index * 0.05,
      low: 99 + index * 0.05,
    }));
    const result = calculateSelectionScore(stock, benchmark, 'trend');
    expect(result.benchmarkAvailable).toBe(true);
    expect(result.relativeStrength20d).not.toBeNull();
    expect(result.relativeStrength60d).not.toBeNull();
    expect(result.sections.find((item) => item.key === 'market')?.items[0].available).toBe(true);
  });

  it('keeps dividend yield as the highest-weight value factor and exposes missing data', () => {
    const stock = makeSeries(180, (index) => 100 + Math.sin(index / 10));
    const benchmark = makeSeries(180, (index) => 100 + Math.sin(index / 12));
    const complete = calculateSelectionScore(stock, benchmark, 'value', {
      dividendYieldPct: 5,
      peTtm: 10,
      pb: 1,
      roePct: 15,
      marketCapYi: 800,
    });
    const missing = calculateSelectionScore(stock, benchmark, 'value', {
      peTtm: 10,
      pb: 1,
      roePct: 15,
      marketCapYi: 800,
    });
    const completeDividend = complete.sections
      .flatMap((item) => item.items)
      .find((item) => item.label === '近12个月股息率')!;
    const missingDividend = missing.sections
      .flatMap((item) => item.items)
      .find((item) => item.label === '近12个月股息率')!;

    expect(completeDividend.points).toBe(22);
    expect(completeDividend.detail).toContain('权重 22%');
    expect(missingDividend.available).toBe(false);
    expect(missingDividend.detail).toContain('按中性 50 分占位');
    expect(missing.dataCoveragePct).toBe(78);
    expect(missing.assumptions.some((item) => item.includes('最高权重因子（22%）'))).toBe(true);
  });

  it('uses real financial growth instead of high valuation as a growth proxy', () => {
    const stock = makeSeries(180, (index) => 100 + index * 0.15);
    const benchmark = makeSeries(180, (index) => 100 + index * 0.1);
    const fast = calculateSelectionScore(stock, benchmark, 'growth', {
      revenueGrowthPct: 35,
      netProfitGrowthPct: 50,
      roePct: 18,
      marketCapYi: 500,
    });
    const shrinking = calculateSelectionScore(stock, benchmark, 'growth', {
      revenueGrowthPct: -10,
      netProfitGrowthPct: -20,
      roePct: 4,
      marketCapYi: 500,
    });
    expect(fast.sections.find((item) => item.key === 'growth')!.score)
      .toBeGreaterThan(shrinking.sections.find((item) => item.key === 'growth')!.score);
    expect(fast.score).toBeGreaterThan(shrinking.score!);
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
    expect(liquidResult.assumptions).toContain('流动性硬过滤使用历史K线提供的真实成交额。');
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
    expect(result.sections.some((item) => item.key === 'liquidity')).toBe(true);
    expect(result.assumptions.some((item) => item.includes('换手率'))).toBe(true);
    const turnover = result.sections.flatMap((item) => item.items).find((item) => item.label === '换手率');
    expect(turnover).toMatchObject({ available: false });
    const totalMax = result.sections.reduce((sum, item) => sum + (item.maxScore ?? 0), 0);
    expect(totalMax).toBe(100);
  });
});
