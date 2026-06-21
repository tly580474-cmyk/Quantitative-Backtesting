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

  visibleRange: { from: string; to: string } | null;
  rangeLineStart: string | null;
  rangeLineEnd: string | null;
  rangeLineDragging: 'start' | 'end' | null;

  setCrosshairTime: (time: string | null) => void;
  setCrosshairData: (data: ChartState['crosshairData']) => void;
  setCrosshairIndicators: (data: ChartState['crosshairIndicators']) => void;
  setVisibleRange: (range: { from: string; to: string } | null) => void;
  setRangeLineState: (state: { startTime: string | null; endTime: string | null; dragging: 'start' | 'end' | null }) => void;
  clear: () => void;
}

export const useChartStore = create<ChartState>((set) => ({
  crosshairTime: null,
  crosshairData: null,
  crosshairIndicators: [],
  visibleRange: null,
  rangeLineStart: null,
  rangeLineEnd: null,
  rangeLineDragging: null,

  setCrosshairTime: (time) => set({ crosshairTime: time }),
  setCrosshairData: (data) => set({ crosshairData: data }),
  setCrosshairIndicators: (data) => set({ crosshairIndicators: data }),
  setVisibleRange: (range) => set({ visibleRange: range }),
  setRangeLineState: (state) => set({
    rangeLineStart: state.startTime,
    rangeLineEnd: state.endTime,
    rangeLineDragging: state.dragging,
  }),
  clear: () => set({
    crosshairTime: null,
    crosshairData: null,
    crosshairIndicators: [],
    visibleRange: null,
    rangeLineStart: null,
    rangeLineEnd: null,
    rangeLineDragging: null,
  }),
}));
