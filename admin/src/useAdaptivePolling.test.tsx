import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAdaptivePolling } from './useAdaptivePolling';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('pauses hidden tabs, resumes once and never overlaps a slow request', async () => {
  vi.useFakeTimers();
  let visible = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  let finish!: () => void;
  const poll = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  renderHook(() => useAdaptivePolling(poll, 10_000));
  expect(poll).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(poll).toHaveBeenCalledTimes(1);
  visible = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => finish());
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(poll).toHaveBeenCalledTimes(1);
  visible = true;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(poll).toHaveBeenCalledTimes(2);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => finish());
  poll.mockImplementation(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(poll).toHaveBeenCalledTimes(3);
});

it('adapts between idle and active delays and backs off failed requests', async () => {
  vi.useFakeTimers();
  const poll = vi.fn().mockResolvedValue(undefined);
  const { rerender } = renderHook(({ delay }) => useAdaptivePolling(poll, delay), { initialProps: { delay: 60_000 } });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(poll).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(50_000));
  expect(poll).toHaveBeenCalledTimes(2);
  rerender({ delay: 10_000 });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(poll).toHaveBeenCalledTimes(4);
  poll.mockRejectedValueOnce(new Error('temporary'));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(poll).toHaveBeenCalledTimes(5);
  await act(() => vi.advanceTimersByTimeAsync(19_999));
  expect(poll).toHaveBeenCalledTimes(5);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(poll).toHaveBeenCalledTimes(6);
});
