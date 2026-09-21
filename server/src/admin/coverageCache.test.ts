// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createAdminCoverageReader } from './coverageCache.js';
import type { CoverageMatrix } from '../research/dataCoverageMatrix.js';

const matrix: CoverageMatrix = { status: 'pass', checkedAt: '2026-09-21T07:00:00Z', authoritativeDate: null,
  rows: [{ key: 'dragon_tiger', label: '龙虎榜', status: 'pass', rows: 1, covered: 1, total: 1,
    coverage: 1, minDate: null, maxDate: null, message: 'ok' }] };
afterEach(() => { vi.useRealTimers(); });

it('returns immediately on a cold cache and shares one pending scan across concurrent requests', async () => {
  let finish!: (value: CoverageMatrix) => void;
  const rebuild = vi.fn(() => new Promise<CoverageMatrix>(resolve => { finish = resolve; }));
  const read = createAdminCoverageReader({ read: async () => null, rebuild });
  const responses = await Promise.all([read(), read(), read()]);
  expect(responses).toEqual(Array(3).fill({ matrix: null, refreshing: true, failed: false }));
  expect(rebuild).toHaveBeenCalledTimes(1);
  finish(matrix);
  await vi.waitFor(async () => expect((await read()).matrix).toBe(matrix));
  expect((await read()).refreshing).toBe(false);
});

it('serves stale results while refreshing, without claiming that they are current', async () => {
  const read = createAdminCoverageReader({ read: async age => age === Infinity ? matrix : null,
    rebuild: () => new Promise(() => {}) });
  expect(await read()).toEqual({ matrix, refreshing: true, failed: false });
});

it('does not start an expensive scan for a fresh disk cache', async () => {
  const rebuild = vi.fn();
  const read = createAdminCoverageReader({ read: async () => matrix, rebuild });
  expect(await read()).toEqual({ matrix, refreshing: false, failed: false });
  expect(rebuild).not.toHaveBeenCalled();
});

it('contains rebuild failures and backs off before retrying', async () => {
  vi.useFakeTimers();
  const rebuild = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(matrix);
  const read = createAdminCoverageReader({ read: async () => null, rebuild });
  await read();
  await vi.advanceTimersByTimeAsync(0);
  expect(await read()).toEqual({ matrix: null, refreshing: false, failed: true });
  expect(rebuild).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await read()).refreshing).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect((await read()).matrix).toBe(matrix);
  expect(rebuild).toHaveBeenCalledTimes(2);
});

it('refreshes the in-memory result after its TTL rather than retaining it forever', async () => {
  vi.useFakeTimers();
  const rebuild = vi.fn().mockResolvedValue(matrix);
  const read = createAdminCoverageReader({ read: async () => null, rebuild });
  await read();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
  expect(await read()).toMatchObject({ matrix, refreshing: true });
  expect(rebuild).toHaveBeenCalledTimes(2);
});
