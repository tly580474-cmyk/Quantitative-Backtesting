import { create } from 'zustand';
import type { BacktestConfig, BacktestResult, StrategySignal } from '@/models';
import {
  saveResult,
  getResults,
  deleteResult as deleteResultFromDb,
} from '@/db/resultRepository';

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 100000,
  positionSizing: { type: 'percent', value: 1 },
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.001,
  slippageBps: 1,
  lotSize: 100,
  execution: 'next_open',
  forceCloseAtEnd: true,
};

interface BacktestState {
  config: BacktestConfig;
  signals: StrategySignal[];
  showSignals: 'raw' | 'executed';
  results: BacktestResult[];
  selectedResultIds: string[];

  setConfig: (config: Partial<BacktestConfig>) => void;
  resetConfig: () => void;
  setSignals: (signals: StrategySignal[]) => void;
  setShowSignals: (mode: 'raw' | 'executed') => void;

  loadResults: () => Promise<void>;
  addResult: (result: BacktestResult) => Promise<void>;
  removeResult: (id: string) => Promise<void>;
  toggleResultSelection: (id: string) => void;
  clearSelection: () => void;
}

export const useBacktestStore = create<BacktestState>((set, get) => ({
  config: { ...DEFAULT_BACKTEST_CONFIG },
  signals: [],
  showSignals: 'raw',
  results: [],
  selectedResultIds: [],

  setConfig: (partial) =>
    set((s) => ({ config: { ...s.config, ...partial } })),

  resetConfig: () => set({ config: { ...DEFAULT_BACKTEST_CONFIG } }),

  setSignals: (signals) => set({ signals }),

  setShowSignals: (mode) => set({ showSignals: mode }),

  loadResults: async () => {
    set({ results: await getResults() });
  },

  addResult: async (result) => {
    await saveResult(result, result.equityCurve);
    set((s) => ({
      results: [result, ...s.results],
    }));
  },

  removeResult: async (id) => {
    await deleteResultFromDb(id);
    set((s) => ({
      results: s.results.filter((r) => r.id !== id),
      selectedResultIds: s.selectedResultIds.filter((rid) => rid !== id),
    }));
  },

  toggleResultSelection: (id) =>
    set((s) => {
      const selected = s.selectedResultIds.includes(id)
        ? s.selectedResultIds.filter((rid) => rid !== id)
        : [...s.selectedResultIds, id].slice(0, 3); // Max 3 for comparison
      return { selectedResultIds: selected };
    }),

  clearSelection: () => set({ selectedResultIds: [] }),
}));
