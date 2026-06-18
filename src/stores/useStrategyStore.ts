import { create } from 'zustand';
import { getStrategyById } from '@/features/strategies/registry';
import {
  saveStrategyConfig,
  getStrategyConfigs,
  deleteStrategyConfig as deleteConfig,
} from '@/db/strategyRepository';
import type { StrategyConfig } from '@/models';

interface StrategyState {
  configs: StrategyConfig[];
  activeStrategyId: string;
  activeParams: Record<string, number | boolean | string>;

  loadConfigs: () => Promise<void>;
  selectStrategy: (strategyId: string) => void;
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
    const configs = await getStrategyConfigs();
    set({ configs });
  },

  selectStrategy: (strategyId) => {
    const strategy = getStrategyById(strategyId);
    if (!strategy) return;
    const activeParams = { ...strategy.defaultParams };
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
    await saveStrategyConfig(config);
    await get().loadConfigs();
  },

  deleteConfig: async (id) => {
    await deleteConfig(id);
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
    await saveStrategyConfig(newConfig);
    await get().loadConfigs();
  },
}));
