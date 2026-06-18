import type { Candle } from './Candle';
import type { PositionSnapshot } from './Position';

export type SignalAction = 'buy' | 'sell' | 'hold';

export interface StrategySignal {
  time: string;
  action: SignalAction;
  reason: string;
  strength?: number;
}

export interface StrategyContext {
  index: number;
  candles: readonly Candle[];
  indicators: Readonly<Record<string, readonly (number | null)[]>>;
  position: Readonly<PositionSnapshot>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StrategyDefinition<P = any> {
  id: string;
  name: string;
  version: string;
  description: string;
  paramsSchema: StrategyParamDef[];
  defaultParams: P;
  warmupBars: (params: P) => number;
  evaluate: (context: StrategyContext, params: P) => StrategySignal;
}

export interface StrategyParamDef {
  name: string;
  label: string;
  type: 'number' | 'boolean' | 'select';
  defaultValue: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string | number | boolean }[];
  description?: string;
}

export interface StrategyConfig {
  id: string;
  name: string;
  strategyId: string;
  params: Record<string, number | boolean | string>;
  createdAt: string;
  updatedAt: string;
}
