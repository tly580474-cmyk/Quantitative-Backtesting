import { create } from 'zustand';
import type { Candle, ImportResult } from '@/models';

interface CandleState {
  candles: Candle[];
  importResult: ImportResult | null;
  loading: boolean;

  setCandles: (candles: Candle[]) => void;
  setImportResult: (result: ImportResult | null) => void;
  setLoading: (loading: boolean) => void;
  clear: () => void;
}

export const useCandleStore = create<CandleState>((set) => ({
  candles: [],
  importResult: null,
  loading: false,

  setCandles: (candles) => set({ candles }),
  setImportResult: (result) => set({ importResult: result }),
  setLoading: (loading) => set({ loading }),
  clear: () => set({ candles: [], importResult: null, loading: false }),
}));
