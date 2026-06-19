import { create } from 'zustand';
import type { BacktestConfig, BacktestResult, StrategySignal } from '@/models';
import type { VisualStrategyDocument } from '@/features/visualStrategies/types';
import type { StrategySource } from '@/workers/protocol';
import {
  saveResult,
  getResults,
  deleteResult as deleteResultFromDb,
  deleteResults as deleteResultsFromDb,
} from '@/db/resultRepository';

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  backtestMode: 'strategy',
  initialCapital: 100000,
  tradingDays: 0,
  positionSizing: { type: 'percent', value: 1 },
  commissionRate: 0.0003,
  minimumCommission: 5,
  sellTaxRate: 0.001,
  slippageBps: 1,
  tradingUnitMode: 'index',
  minimumTradeAmount: 1,
  dca: { amount: 1000, frequency: 'monthly' },
  execution: 'next_open',
  forceCloseAtEnd: true,
};

interface BacktestState {
  config: BacktestConfig;
  signals: StrategySignal[];
  showSignals: 'raw' | 'executed';
  results: BacktestResult[];
  selectedResultIds: string[];

  // Visual strategy support
  strategySource: StrategySource;
  visualStrategyDocument: VisualStrategyDocument | null;

  setConfig: (config: Partial<BacktestConfig>) => void;
  resetConfig: () => void;
  setSignals: (signals: StrategySignal[]) => void;
  setShowSignals: (mode: 'raw' | 'executed') => void;
  setStrategySource: (source: StrategySource) => void;
  setVisualStrategyDocument: (doc: VisualStrategyDocument | null) => void;

  loadResults: () => Promise<void>;
  addResult: (result: BacktestResult) => Promise<void>;
  removeResult: (id: string) => Promise<void>;
  removeResults: (ids: string[]) => Promise<void>;
  toggleResultSelection: (id: string) => void;
  selectAllResults: () => void;
  clearSelection: () => void;
}

export const useBacktestStore = create<BacktestState>((set, get) => ({
  config: { ...DEFAULT_BACKTEST_CONFIG },
  signals: [],
  showSignals: 'raw',
  results: [],
  selectedResultIds: [],
  strategySource: 'builtin',
  visualStrategyDocument: null,

  setConfig: (partial) =>
    set((s) => ({ config: { ...s.config, ...partial } })),

  resetConfig: () => set({ config: { ...DEFAULT_BACKTEST_CONFIG } }),

  setSignals: (signals) => set({ signals }),

  setShowSignals: (mode) => set({ showSignals: mode }),

  setStrategySource: (source) => set({ strategySource: source }),
  setVisualStrategyDocument: (doc) => set({ visualStrategyDocument: doc }),

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

  removeResults: async (ids) => {
    await deleteResultsFromDb(ids);
    const removed = new Set(ids);
    set((s) => ({
      results: s.results.filter((r) => !removed.has(r.id)),
      selectedResultIds: s.selectedResultIds.filter((id) => !removed.has(id)),
    }));
  },

  toggleResultSelection: (id) =>
    set((s) => {
      const selected = s.selectedResultIds.includes(id)
        ? s.selectedResultIds.filter((rid) => rid !== id)
        : [...s.selectedResultIds, id];
      return { selectedResultIds: selected };
    }),

  selectAllResults: () => set((s) => ({
    selectedResultIds: s.results.map((result) => result.id),
  })),

  clearSelection: () => set({ selectedResultIds: [] }),
}));
