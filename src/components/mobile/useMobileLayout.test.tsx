import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_LAYOUT_QUERY, useMobileLayout } from './useMobileLayout';

interface MediaQueryMock {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  emit(nextMatches: boolean): void;
}

function createMediaQueryMock(): MediaQueryMock {
  let matches = false;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  return {
    get matches() {
      return matches;
    },
    media: MOBILE_LAYOUT_QUERY,
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener);
    }),
    emit(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: MOBILE_LAYOUT_QUERY } as MediaQueryListEvent;
      listeners.forEach((listener) => {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      });
    },
  };
}

function LayoutProbe() {
  const mobile = useMobileLayout();
  return <output data-testid="layout-mode">{mobile ? 'mobile' : 'desktop'}</output>;
}

describe('useMobileLayout', () => {
  let media: MediaQueryMock;

  beforeEach(() => {
    media = createMediaQueryMock();
    vi.stubGlobal('matchMedia', vi.fn(() => media));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tracks media changes and removes the change subscription on unmount', async () => {
    const result = render(<LayoutProbe />);
    expect(screen.getByTestId('layout-mode').textContent).toBe('desktop');

    await waitFor(() => expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function)));
    const listener = media.addEventListener.mock.calls[0]?.[1];

    act(() => media.emit(true));
    await waitFor(() => expect(screen.getByTestId('layout-mode').textContent).toBe('mobile'));

    act(() => media.emit(false));
    await waitFor(() => expect(screen.getByTestId('layout-mode').textContent).toBe('desktop'));

    result.unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', listener);
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);

    act(() => media.emit(true));
    expect(screen.queryByTestId('layout-mode')).toBeNull();
  });
});
