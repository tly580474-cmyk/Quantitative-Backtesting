import type { Candle } from '@/models';
import type { SignalAction, StrategySignal, StrategyContext } from '@/models/Strategy';
import type { PositionSnapshot } from '@/models/Position';
import type { StrategyDefinition } from '@/models/Strategy';

// Re-export core types for convenience
export type { SignalAction, StrategySignal, StrategyContext };
export type { PositionSnapshot };
export type { StrategyDefinition };

export function createContext(
  index: number,
  candles: readonly Candle[],
  indicators: Readonly<Record<string, readonly (number | null)[]>>,
  position: Readonly<PositionSnapshot>,
): StrategyContext {
  return { index, candles, indicators, position };
}
