import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDetailIndicators } from './useDetailIndicators';

const STORAGE_KEY = 'quant-mobile-detail-indicators-v1';
const MOBILE_DEFAULT = { ma: true, rsi: false, macd: false };
const DESKTOP_DEFAULT = { ma: true, rsi: true, macd: true };

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('useDetailIndicators', () => {
  it('uses the mobile first visit default and persists a changed preference', () => {
    const first = renderHook(() => useDetailIndicators(true));
    expect(first.result.current[0]).toEqual(MOBILE_DEFAULT);

    act(() => first.result.current[1]({ ma: false, rsi: true, macd: false }));
    expect(first.result.current[0]).toEqual({ ma: false, rsi: true, macd: false });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ ma: false, rsi: true, macd: false }));
    first.unmount();

    const second = renderHook(() => useDetailIndicators(true));
    expect(second.result.current[0]).toEqual({ ma: false, rsi: true, macd: false });
  });

  it('keeps desktop defaults and updates isolated from mobile preference storage', () => {
    const mobilePreference = { ma: false, rsi: true, macd: true };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mobilePreference));

    const desktop = renderHook(() => useDetailIndicators(false));
    expect(desktop.result.current[0]).toEqual(DESKTOP_DEFAULT);
    act(() => desktop.result.current[1]({ ma: false, rsi: false, macd: true }));
    expect(desktop.result.current[0]).toEqual({ ma: false, rsi: false, macd: true });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(mobilePreference));

    desktop.unmount();
    const mobile = renderHook(() => useDetailIndicators(true));
    expect(mobile.result.current[0]).toEqual(mobilePreference);
  });

  it('falls back to the mobile default when stored JSON is malformed or incomplete', () => {
    localStorage.setItem(STORAGE_KEY, '{broken-json');
    const malformed = renderHook(() => useDetailIndicators(true));
    expect(malformed.result.current[0]).toEqual(MOBILE_DEFAULT);
    malformed.unmount();

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ma: true, rsi: false }));
    const incomplete = renderHook(() => useDetailIndicators(true));
    expect(incomplete.result.current[0]).toEqual(MOBILE_DEFAULT);
  });
});
