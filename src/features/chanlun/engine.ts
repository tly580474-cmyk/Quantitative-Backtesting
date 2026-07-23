import type { Candle } from '@/models';
import { CHAN_V1_CONFIG } from './config';
import { createChanFingerprint } from './fingerprint';
import { identifyStrictFractals } from './fractals';
import { resolveContainment } from './include';
import { buildPens } from './pens';
import { buildSegments } from './segments';
import { buildCenters } from './centers';
import type { ChanAnalysis, ChanConfig } from './types';

function validateCandles(candles: readonly Candle[]): void {
  candles.forEach((candle, index) => {
    if (!candle.time) throw new Error(`K线 ${index} 缺少时间`);
    if (index > 0 && candle.time <= candles[index - 1].time) {
      throw new Error(`K线时间必须严格递增：${candles[index - 1].time} -> ${candle.time}`);
    }
    const values = [candle.open, candle.high, candle.low, candle.close];
    if (!values.every(Number.isFinite)) throw new Error(`K线 ${candle.time} 含非有限价格`);
    if (candle.high < Math.max(candle.open, candle.low, candle.close)
      || candle.low > Math.min(candle.open, candle.high, candle.close)) {
      throw new Error(`K线 ${candle.time} 的 OHLC 区间非法`);
    }
  });
}

export function analyzeChanlun(
  candles: readonly Candle[],
  config: ChanConfig = CHAN_V1_CONFIG,
): ChanAnalysis {
  validateCandles(candles);
  const sourceBars = [...candles];
  const mergedBars = resolveContainment(sourceBars);
  const fractals = identifyStrictFractals(mergedBars, sourceBars);
  const pens = buildPens(fractals, config);
  const segments = buildSegments(pens);
  const penCenters = buildCenters(pens, 'pen');
  const segmentCenters = buildCenters(segments, 'segment');
  const lastSourceIndex = sourceBars.length ? sourceBars.length - 1 : null;
  const warnings: string[] = [];
  if (sourceBars.length < 7) warnings.push('K线数量较少，可能不足以形成有效笔。');

  return {
    config: { ...config },
    fingerprint: createChanFingerprint(sourceBars, config),
    sourceBars,
    mergedBars,
    fractals,
    pens,
    segments,
    penCenters,
    segmentCenters,
    current: {
      currentPenId: pens[pens.length - 1]?.id ?? null,
      currentSegmentId: segments[segments.length - 1]?.id ?? null,
      latestPenCenterId: penCenters[penCenters.length - 1]?.id ?? null,
      latestSegmentCenterId: segmentCenters[segmentCenters.length - 1]?.id ?? null,
      asOfIndex: lastSourceIndex,
      asOf: lastSourceIndex == null ? null : sourceBars[lastSourceIndex].time,
    },
    warnings,
  };
}
