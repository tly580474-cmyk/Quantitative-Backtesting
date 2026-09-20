import { afterEach, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { checkConnection } from './connection.js';

afterEach(() => vi.useRealTimers());

it('releases a connection acquired after the probe deadline', async () => {
  vi.useFakeTimers();
  const conn = { ping: vi.fn(), release: vi.fn(), destroy: vi.fn() };
  let acquired!: (value: typeof conn) => void;
  const pool = { getConnection: () => new Promise(resolve => { acquired = resolve; }) } as unknown as Pool;
  const result = checkConnection(pool);
  await vi.advanceTimersByTimeAsync(3_001);
  expect((await result).ok).toBe(false);
  acquired(conn);
  await Promise.resolve();
  expect(conn.release).toHaveBeenCalledOnce();
  expect(conn.ping).not.toHaveBeenCalled();
});

it('destroys a connection with a hanging ping and releases a failed ping', async () => {
  vi.useFakeTimers();
  const conn = { ping: vi.fn(() => new Promise(() => {})), release: vi.fn(), destroy: vi.fn() };
  const pool = { getConnection: async () => conn } as unknown as Pool;
  const result = checkConnection(pool);
  await vi.advanceTimersByTimeAsync(3_001);
  expect((await result).ok).toBe(false);
  expect(conn.destroy).toHaveBeenCalledOnce();
  expect(conn.release).not.toHaveBeenCalled();
  conn.ping.mockRejectedValueOnce(new Error('offline'));
  expect((await checkConnection(pool)).ok).toBe(false);
  expect(conn.release).toHaveBeenCalledOnce();
});
