import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFullscreen } from './useFullscreen';

describe('useFullscreen', () => {
  const originalRequestFullscreen = document.documentElement.requestFullscreen;
  const originalExitFullscreen = document.exitFullscreen;
  const originalFullscreenElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');

  afterEach(() => {
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: originalRequestFullscreen,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: originalExitFullscreen,
    });
    if (originalFullscreenElement) Object.defineProperty(document, 'fullscreenElement', originalFullscreenElement);
    else Reflect.deleteProperty(document, 'fullscreenElement');
  });

  it('enters fullscreen and tracks the native fullscreenchange event', async () => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenElement = document.documentElement;
        document.dispatchEvent(new Event('fullscreenchange'));
      }),
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      }),
    });

    const { result } = renderHook(() => useFullscreen());
    expect(result.current.supported).toBe(true);
    expect(result.current.isFullscreen).toBe(false);

    await act(() => result.current.toggleFullscreen());
    expect(result.current.isFullscreen).toBe(true);

    await act(() => result.current.toggleFullscreen());
    expect(result.current.isFullscreen).toBe(false);
  });
});
