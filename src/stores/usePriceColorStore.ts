import { create } from 'zustand';
import { getPriceColors, type PriceColorMode } from '@/priceColors';

export const PRICE_COLOR_KEY = 'quant-backtest:price-color-mode';
export function readPriceColorMode(): PriceColorMode {
  try { return localStorage.getItem(PRICE_COLOR_KEY) === 'green-up' ? 'green-up' : 'red-up'; }
  catch { return 'red-up'; }
}

function applyMode(mode: PriceColorMode) {
  if (typeof document === 'undefined') return;
  const colors = getPriceColors(mode);
  document.documentElement.dataset.priceColorMode = mode;
  document.documentElement.style.setProperty('--market-up', colors.up);
  document.documentElement.style.setProperty('--market-down', colors.down);
}

const initialMode = readPriceColorMode();
applyMode(initialMode);
export const usePriceColorStore = create<{
  mode: PriceColorMode;
  setMode: (mode: PriceColorMode) => void;
}>((set) => ({
  mode: initialMode,
  setMode: (mode) => {
    applyMode(mode);
    try { localStorage.setItem(PRICE_COLOR_KEY, mode); } catch { /* Session preference still works. */ }
    set({ mode });
  },
}));

export function usePriceColors() {
  return getPriceColors(usePriceColorStore((state) => state.mode));
}
