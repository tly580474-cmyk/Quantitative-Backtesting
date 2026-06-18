import { db } from './database';
import type { StrategyConfig } from '@/models';

export async function saveStrategyConfig(config: StrategyConfig): Promise<void> {
  await db.strategyConfigs.put(config);
}

export async function getStrategyConfig(id: string): Promise<StrategyConfig | undefined> {
  return db.strategyConfigs.get(id);
}

export async function getStrategyConfigs(): Promise<StrategyConfig[]> {
  return db.strategyConfigs.orderBy('createdAt').reverse().toArray();
}

export async function deleteStrategyConfig(id: string): Promise<void> {
  await db.strategyConfigs.delete(id);
}
