import type { Candle } from '@/models';
import { CHAN_V1_CONFIG } from './config';
import { analyzeChanlun } from './engine';
import type { ChanAnalysis, ChanConfig } from './types';

/**
 * Append-only API for live/workspace use. M1 deliberately recomputes the small
 * structure state so incremental and batch semantics cannot drift. Its internals
 * can later be optimized without changing consumers.
 */
export class IncrementalChanEngine {
  private readonly candles: Candle[] = [];

  constructor(private readonly config: ChanConfig = CHAN_V1_CONFIG) {}

  append(candle: Candle): ChanAnalysis {
    this.candles.push(candle);
    try {
      return this.snapshot();
    } catch (error) {
      this.candles.pop();
      throw error;
    }
  }

  snapshot(): ChanAnalysis {
    return analyzeChanlun(this.candles, this.config);
  }

  reset(): void {
    this.candles.length = 0;
  }
}

