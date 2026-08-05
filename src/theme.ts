import { useState, useEffect } from 'react';

export type ColorMode = 'light' | 'dark';

export const COLOR_MODE_STORAGE_KEY = 'quant-color-mode-v1';

/** React hook: observe `data-theme` on <html> and return whether dark mode is active. */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark',
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme === 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export interface AgentThemeColors {
  bg: string;
  bgSubtle: string;
  bgCard: string;
  bgInput: string;
  bgUserBubble: string;
  bgHover: string;
  bgSelected: string;
  bgGradientTop: string;
  border: string;
  borderSubtle: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  textOnBlue: string;
  codeBg: string;
  codeBorder: string;
  errorBg: string;
  errorBorder: string;
  errorText: string;
}

const LIGHT_COLORS: AgentThemeColors = {
  bg: '#ffffff',
  bgSubtle: '#fafafa',
  bgCard: '#ffffff',
  bgInput: '#ffffff',
  bgUserBubble: '#f9fafb',
  bgHover: '#f0f0f0',
  bgSelected: '#e6f0ff',
  bgGradientTop: '#ffffff',
  border: '#e5e7eb',
  borderSubtle: '#ececf1',
  text: '#374151',
  textSecondary: '#8e8ea0',
  textMuted: '#9ca3af',
  textOnBlue: '#1a73e8',
  codeBg: '#ffffff',
  codeBorder: '#f0f0f0',
  errorBg: '#fef2f2',
  errorBorder: '#fee2e2',
  errorText: '#b91c1c',
};

const DARK_COLORS: AgentThemeColors = {
  bg: '#0f172a',
  bgSubtle: '#0f172a',
  bgCard: '#1e293b',
  bgInput: '#1e293b',
  bgUserBubble: '#1e293b',
  bgHover: '#172033',
  bgSelected: '#172554',
  bgGradientTop: '#0f172a',
  border: '#334155',
  borderSubtle: '#243247',
  text: '#e2e8f0',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',
  textOnBlue: '#60a5fa',
  codeBg: '#0f172a',
  codeBorder: '#334155',
  errorBg: '#2a0f12',
  errorBorder: '#7f1d1d',
  errorText: '#fca5a5',
};

export function useAgentTheme(): AgentThemeColors {
  return useDarkMode() ? DARK_COLORS : LIGHT_COLORS;
}

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
