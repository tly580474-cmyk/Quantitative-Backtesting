import type { Candle } from '@/models';
import { analyzeChanlun } from './engine';
import type { ChanAnalysis, ChanConfig } from './types';

export interface ChanReplayFrame {
  asOfIndex: number;
  asOf: string;
  analysis: ChanAnalysis;
}

/** 计算某个历史收盘时点真实可见的结构快照。 */
export function analyzeChanlunAt(
  candles: readonly Candle[],
  asOfIndex: number,
  config?: ChanConfig,
): ChanAnalysis {
  if (!Number.isInteger(asOfIndex) || asOfIndex < 0 || asOfIndex >= candles.length) {
    throw new RangeError(`asOfIndex ${asOfIndex} 超出行情范围 0..${candles.length - 1}`);
  }
  return config
    ? analyzeChanlun(candles.slice(0, asOfIndex + 1), config)
    : analyzeChanlun(candles.slice(0, asOfIndex + 1));
}

/** 惰性逐 K 回放；调用方可中途停止，不会预先读取未来结构。 */
export function* replayChanlun(
  candles: readonly Candle[],
  config?: ChanConfig,
): Generator<ChanReplayFrame> {
  for (let asOfIndex = 0; asOfIndex < candles.length; asOfIndex += 1) {
    const analysis = analyzeChanlunAt(candles, asOfIndex, config);
    yield { asOfIndex, asOf: candles[asOfIndex].time, analysis };
  }
}
