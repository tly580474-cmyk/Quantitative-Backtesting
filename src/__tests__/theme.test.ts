import { describe, expect, it } from 'vitest';
import {
  applyColorMode,
  COLOR_MODE_STORAGE_KEY,
  getChartSurfaceColors,
  readColorMode,
} from '../theme';

describe('color mode', () => {
  it('defaults to light and restores a saved dark preference', () => {
    expect(readColorMode({ getItem: () => null })).toBe('light');
    expect(readColorMode({
      getItem: (key) => key === COLOR_MODE_STORAGE_KEY ? 'dark' : null,
    })).toBe('dark');
  });

  it('applies the theme to the document root', () => {
    applyColorMode('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(getChartSurfaceColors().background).toBe('#0f172a');
    applyColorMode('light');
    expect(getChartSurfaceColors().background).toBe('#ffffff');
  });
});
