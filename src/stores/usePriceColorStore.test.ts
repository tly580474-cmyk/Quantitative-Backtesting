import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPriceColors } from '@/priceColors';
import { PRICE_COLOR_KEY, readPriceColorMode, usePriceColorStore } from './usePriceColorStore';

afterEach(() => {
  vi.restoreAllMocks();
  usePriceColorStore.getState().setMode('red-up');
  localStorage.removeItem(PRICE_COLOR_KEY);
});

describe('price color preference', () => {
  it('defaults to red up for missing or invalid preferences', () => {
    localStorage.removeItem(PRICE_COLOR_KEY);
    expect(readPriceColorMode()).toBe('red-up');
    localStorage.setItem(PRICE_COLOR_KEY, 'invalid');
    expect(readPriceColorMode()).toBe('red-up');
  });

  it('remembers both conventions independently of theme and updates price tokens', () => {
    document.documentElement.dataset.theme = 'dark';
    for (const mode of ['green-up', 'red-up'] as const) {
      usePriceColorStore.getState().setMode(mode);
      expect(readPriceColorMode()).toBe(mode);
      expect(usePriceColorStore.getState().mode).toBe(mode);
      expect(document.documentElement.style.getPropertyValue('--market-up')).toBe(getPriceColors(mode).up);
      expect(document.documentElement.style.getPropertyValue('--market-down')).toBe(getPriceColors(mode).down);
      expect(document.documentElement.dataset.theme).toBe('dark');
    }
  });

  it('still updates the session when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    expect(readPriceColorMode()).toBe('red-up');
    expect(() => usePriceColorStore.getState().setMode('green-up')).not.toThrow();
    expect(usePriceColorStore.getState().mode).toBe('green-up');
    expect(document.documentElement.dataset.priceColorMode).toBe('green-up');
  });
});
