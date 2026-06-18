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

  setCrosshairTime: (time: string | null) => void;
  setCrosshairData: (data: ChartState['crosshairData']) => void;
  clear: () => void;
}

export const useChartStore = create<ChartState>((set) => ({
  crosshairTime: null,
  crosshairData: null,

  setCrosshairTime: (time) => set({ crosshairTime: time }),
  setCrosshairData: (data) => set({ crosshairData: data }),
  clear: () => set({ crosshairTime: null, crosshairData: null }),
}));
