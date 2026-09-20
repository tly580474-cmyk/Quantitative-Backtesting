import { afterEach, expect, it, vi } from 'vitest';
import { createAsyncCache } from './asyncCache.js';

afterEach(() => vi.useRealTimers());
it('shares concurrent work, expires from completion, and retries failed collections', async () => {
  vi.useFakeTimers();
  const cache = createAsyncCache<number>(1_000);
  let finish!: (value: number) => void;
  const collect = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
  const first = cache(collect);
  const second = cache(collect);
  await Promise.resolve();
  expect(collect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000);
  finish(42);
  expect(await first).toBe(42);
  expect(await second).toBe(42);
  expect(await cache(collect)).toBe(42);
  await vi.advanceTimersByTimeAsync(1_001);
  await expect(cache(async () => { throw new Error('temporary'); })).rejects.toThrow('temporary');
  expect(await cache(async () => 43)).toBe(43);
});
