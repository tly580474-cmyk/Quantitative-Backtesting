import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('tracks a workbench breakpoint and cleans up its subscription', () => {
  let matches = false;
  const listeners = new Set<() => void>();
  const media = {
    get matches() { return matches; },
    addEventListener: vi.fn((_event, callback) => listeners.add(callback)),
    removeEventListener: vi.fn((_event, callback) => listeners.delete(callback)),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  function Probe() {
    return <output>{useMediaQuery('(min-width: 1440px)') ? '侧栏常驻' : '抽屉布局'}</output>;
  }
  const { unmount } = render(<Probe />);
  expect(screen.getByText('抽屉布局')).toBeTruthy();
  act(() => { matches = true; [...listeners].forEach((callback) => callback()); });
  expect(screen.getByText('侧栏常驻')).toBeTruthy();
  unmount();
  expect(listeners.size).toBe(0);
});
