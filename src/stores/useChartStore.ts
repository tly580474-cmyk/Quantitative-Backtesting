import { create } from 'zustand';

interface ChartState {
  crosshairTime: string | null;
  crosshairData: {
    open: number;
    high: number;
    low: number;
    close: number;
    change?: number;
    changePercent?: number;
    volume?: number;
    turnover?: number;
  } | null;
  crosshairIndicators: Array<{
    id: string;
    name: string;
    values: Array<{
      label: string;
      value: number;
      color: string;
    }>;
  }>;

  setCrosshairTime: (time: string | null) => void;
  setCrosshairData: (data: ChartState['crosshairData']) => void;
  setCrosshairIndicators: (data: ChartState['crosshairIndicators']) => void;
  clear: () => void;
}

export const useChartStore = create<ChartState>((set) => ({
  crosshairTime: null,
  crosshairData: null,
  crosshairIndicators: [],

  setCrosshairTime: (time) => set({ crosshairTime: time }),
  setCrosshairData: (data) => set({ crosshairData: data }),
  setCrosshairIndicators: (data) => set({ crosshairIndicators: data }),
  clear: () => set({
    crosshairTime: null,
    crosshairData: null,
    crosshairIndicators: [],
  }),
}));
