import type { StrategyDefinition } from './types';
import { dualMaStrategy } from './builtins/dualMa';
import { rsiStrategy } from './builtins/rsiStrategy';
import { macdStrategy } from './builtins/macdStrategy';
import { bollStrategy } from './builtins/bollStrategy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const STRATEGY_REGISTRY: StrategyDefinition<any>[] = [
  dualMaStrategy,
  rsiStrategy,
  macdStrategy,
  bollStrategy,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getStrategyById(id: string): StrategyDefinition<any> | undefined {
  return STRATEGY_REGISTRY.find((s) => s.id === id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAllStrategies(): StrategyDefinition<any>[] {
  return STRATEGY_REGISTRY;
}
