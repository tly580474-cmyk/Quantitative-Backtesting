import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWatchlistRefresh, type WatchlistSession } from './useWatchlistRefresh';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/api/client', () => ({ apiFetch: request }));

// Deliberately different server/device clocks: only relative server deadlines
// may control the timer, never the phone's local hour or weekday.
function session(phase: WatchlistSession['phase'], delay: number, key: string | null = null): WatchlistSession {
  const serverNow = Date.now() + 18 * 3_600_000;
  return { phase, sessionDate: '2026-08-31', serverTime: new Date(serverNow).toISOString(),
    nextCheckAt: new Date(serverNow + delay).toISOString(), closeRefreshKey: key };
}
async function advance(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-30T23:00:00Z'));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  request.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('watchlist refresh clock', () => {
  it('refreshes quotes at 5 seconds, reuses session until its boundary, and cleans up', async () => {
    request.mockImplementation(async () => session('trading', 3_600_000));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useWatchlistRefresh(refresh, '600519'));
    await advance();
    expect(refresh).toHaveBeenCalledExactlyOnceWith('live');
    await advance(4_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('loads one closing snapshot on a closed day and only refreshes on explicit request', async () => {
    request.mockImplementation(async () => session('closed', 86_400_000, '2026-08-28:final'));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWatchlistRefresh(refresh, '600519'));
    await advance();
    expect(refresh).toHaveBeenCalledExactlyOnceWith('close');
    await advance(8 * 3_600_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.refresh(); });
    expect(refresh).toHaveBeenLastCalledWith('close');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('takes the final morning quote, pauses for lunch, and resumes at afternoon open', async () => {
    request.mockImplementationOnce(async () => session('trading', 2_000))
      .mockImplementationOnce(async () => session('lunch', 90 * 60_000, '2026-08-31:lunch'))
      .mockImplementation(async () => session('trading', 7_200_000));
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useWatchlistRefresh(refresh, '600519'));
    await advance();
    await advance(2_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(90 * 60_000 - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    await advance(5_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenLastCalledWith('live');
  });

  it('switches to closing snapshots at 15:00, reconciles once at 15:05, then freezes', async () => {
    request.mockImplementationOnce(async () => session('trading', 2_000))
      .mockImplementationOnce(async () => session('closed', 300_000, '2026-08-31:close'))
      .mockImplementation(async () => session('closed', 86_400_000, '2026-08-31:final'));
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useWatchlistRefresh(refresh, '600519'));
    await advance();
    await advance(2_000);
    expect(refresh).toHaveBeenLastCalledWith('close');
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(299_999);
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    await advance(3_600_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('does not guess trading hours when calendar lookup fails, then recovers', async () => {
    request.mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async () => session('unknown', 60_000))
      .mockImplementation(async () => session('trading', 3_600_000));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWatchlistRefresh(refresh, '600519'));
    await advance();
    expect(result.current.phase).toBe('unknown');
    await advance(59_999);
    expect(refresh).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(refresh).not.toHaveBeenCalled();
    await advance(60_000);
    expect(refresh).toHaveBeenCalledExactlyOnceWith('live');
  });

  it('pauses in the background and rechecks session on visibility return', async () => {
    request.mockImplementationOnce(async () => session('trading', 3_600_000))
      .mockImplementation(async () => session('closed', 86_400_000));
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useWatchlistRefresh(refresh, '600519'));
    await advance();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(3_600_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(refresh).toHaveBeenLastCalledWith('close');
  });

  it('does not overlap slow quote requests or restart polling after unmount', async () => {
    request.mockImplementation(async () => session('trading', 3_600_000));
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useWatchlistRefresh(refresh, '600519'));
    await advance();
    await advance(20_000);
    await act(async () => { await result.current.refresh(); });
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { finish(); });
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('skips a missed five-second slot instead of retrying immediately after a slow round', async () => {
    request.mockImplementation(async () => session('trading', 3_600_000));
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    renderHook(() => useWatchlistRefresh(refresh, '600519'));
    await advance();
    await advance(6_000);
    await act(async () => { finish(); });
    await advance(3_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
