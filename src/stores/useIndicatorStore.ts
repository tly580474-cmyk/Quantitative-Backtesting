import { create } from 'zustand';
import type { ActiveIndicator } from '@/models';
import { getIndicatorById } from '@/features/indicators/registry';

interface IndicatorState {
  actives: ActiveIndicator[];
  availableIds: string[];
  usedIds: string[];

  add: (indicatorId: string) => void;
  remove: (indicatorId: string) => void;
  toggle: (indicatorId: string) => void;
  updateParam: (indicatorId: string, paramName: string, value: number) => void;
  resetParams: (indicatorId: string) => void;
  clear: () => void;
}

function createActive(indicatorId: string): ActiveIndicator | null {
  const def = getIndicatorById(indicatorId);
  if (!def) return null;

  const paramValues: Record<string, number> = {};
  for (const p of def.params) {
    paramValues[p.name] = p.defaultValue;
  }

  return {
    id: indicatorId,
    definition: def,
    paramValues,
    visible: true,
  };
}

export const useIndicatorStore = create<IndicatorState>((set, get) => ({
  actives: [],
  availableIds: [
    'sma', 'ema', 'boll', 'macd', 'rsi', 'kdj',
    'atr', 'cci', 'wr', 'obv', 'volumeMa',
  ],
  usedIds: [],

  add: (indicatorId) => {
    const state = get();
    if (state.usedIds.includes(indicatorId)) return;

    const active = createActive(indicatorId);
    if (!active) return;

    set({
      actives: [...state.actives, active],
      usedIds: [...state.usedIds, indicatorId],
    });
  },

  remove: (indicatorId) => {
    set((s) => ({
      actives: s.actives.filter((a) => a.id !== indicatorId),
      usedIds: s.usedIds.filter((id) => id !== indicatorId),
    }));
  },

  toggle: (indicatorId) => {
    set((s) => ({
      actives: s.actives.map((a) =>
        a.id === indicatorId ? { ...a, visible: !a.visible } : a,
      ),
    }));
  },

  updateParam: (indicatorId, paramName, value) => {
    set((s) => ({
      actives: s.actives.map((a) =>
        a.id === indicatorId
          ? { ...a, paramValues: { ...a.paramValues, [paramName]: value } }
          : a,
      ),
    }));
  },

  resetParams: (indicatorId) => {
    const state = get();
    const def = getIndicatorById(indicatorId);
    if (!def) return;

    const paramValues: Record<string, number> = {};
    for (const p of def.params) {
      paramValues[p.name] = p.defaultValue;
    }

    set({
      actives: state.actives.map((a) =>
        a.id === indicatorId ? { ...a, paramValues } : a,
      ),
    });
  },

  clear: () => set({ actives: [], usedIds: [] }),
}));
