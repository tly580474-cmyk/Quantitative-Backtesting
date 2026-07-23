import type { StrategyDefinition } from './types';
import { dualMaStrategy } from './builtins/dualMa';
import { rsiStrategy } from './builtins/rsiStrategy';
import { macdStrategy } from './builtins/macdStrategy';
import { bollStrategy } from './builtins/bollStrategy';
import { smaCrossStrategy } from './builtins/smaCrossStrategy';
import { volatilityStrategy } from './builtins/volatilityStrategy';
import { reversalStrategy } from './builtins/reversalStrategy';
import { compositeFactorStrategy } from './builtins/compositeFactorStrategy';
import { chanCenterBreakoutStrategy } from './builtins/chanCenterBreakoutStrategy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const STRATEGY_REGISTRY: StrategyDefinition<any>[] = [
  dualMaStrategy,
  rsiStrategy,
  macdStrategy,
  bollStrategy,
  smaCrossStrategy,
  volatilityStrategy,
  reversalStrategy,
  compositeFactorStrategy,
  chanCenterBreakoutStrategy,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getStrategyById(id: string): StrategyDefinition<any> | undefined {
  return STRATEGY_REGISTRY.find((s) => s.id === id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAllStrategies(): StrategyDefinition<any>[] {
  return STRATEGY_REGISTRY;
}
