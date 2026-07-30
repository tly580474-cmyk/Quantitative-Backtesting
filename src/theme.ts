export type ColorMode = 'light' | 'dark';

export const COLOR_MODE_STORAGE_KEY = 'quant-color-mode-v1';

export interface ChartSurfaceColors {
  background: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
}

export function readColorMode(storage: Pick<Storage, 'getItem'> = localStorage): ColorMode {
  return storage.getItem(COLOR_MODE_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
}

export function applyColorMode(mode: ColorMode): void {
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
}

export function getChartSurfaceColors(): ChartSurfaceColors {
  return document.documentElement.dataset.theme === 'dark'
    ? {
      background: '#0f172a',
      text: '#94a3b8',
      grid: '#253247',
      border: '#334155',
      crosshair: '#64748b',
    }
    : {
      background: '#ffffff',
      text: '#64748b',
      grid: '#eef2f7',
      border: '#e2e8f0',
      crosshair: '#94a3b8',
    };
}
