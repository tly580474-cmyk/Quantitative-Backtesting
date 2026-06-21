import { create } from 'zustand';
import { getRepository } from '@/api/useRepository';
import { getStrategyById } from '@/features/strategies/registry';
import type { StrategyConfig } from '@/models';

interface StrategyState {
  configs: StrategyConfig[];
  activeStrategyId: string;
  activeParams: Record<string, number | boolean | string>;

  loadConfigs: () => Promise<void>;
  selectStrategy: (
    strategyId: string,
    defaultParams?: Record<string, number | boolean | string>,
  ) => void;
  setParam: (name: string, value: number | boolean | string) => void;
  resetParams: () => void;
  saveConfig: (name: string) => Promise<void>;
  deleteConfig: (id: string) => Promise<void>;
  copyConfig: (id: string) => Promise<void>;
}

export const useStrategyStore = create<StrategyState>((set, get) => ({
  configs: [],
  activeStrategyId: 'dualMa',
  activeParams: {},

  loadConfigs: async () => {
    const configs = await getRepository().getStrategyConfigs();
    set({ configs });
  },

  selectStrategy: (strategyId, defaultParams) => {
    const strategy = getStrategyById(strategyId);
    if (!strategy && !defaultParams) return;
    const activeParams = strategy
      ? { ...strategy.defaultParams }
      : { ...defaultParams };
    set({ activeStrategyId: strategyId, activeParams });
  },

  setParam: (name, value) => {
    set((s) => ({
      activeParams: { ...s.activeParams, [name]: value },
    }));
  },

  resetParams: () => {
    const { activeStrategyId } = get();
    const strategy = getStrategyById(activeStrategyId);
    if (!strategy) return;
    set({ activeParams: { ...strategy.defaultParams } });
  },

  saveConfig: async (name) => {
    const { activeStrategyId, activeParams } = get();
    const config: StrategyConfig = {
      id: crypto.randomUUID(),
      name,
      strategyId: activeStrategyId,
      params: { ...activeParams },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await getRepository().saveStrategyConfig(config);
    await get().loadConfigs();
  },

  deleteConfig: async (id) => {
    await getRepository().deleteStrategyConfig(id);
    await get().loadConfigs();
  },

  copyConfig: async (id) => {
    const config = get().configs.find((c) => c.id === id);
    if (!config) return;
    const newConfig: StrategyConfig = {
      ...config,
      id: crypto.randomUUID(),
      name: `${config.name} (副本)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await getRepository().saveStrategyConfig(newConfig);
    await get().loadConfigs();
  },
}));
