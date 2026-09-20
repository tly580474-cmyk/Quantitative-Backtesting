import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { withSourceMemory } from './sourceMemory.js';
it('bounds retries, separates scopes, expires failures, and permits explicit refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-memory-'));
  let now = 10_000;
  const clock = () => now;
  const transient = vi.fn(async () => ({ exitCode: 1, value: { errorCategory: 'upstream_unavailable' } }));
  const wait = vi.fn(async () => {});
  try {
    await withSourceMemory(dir, ['s1', 'range1'], transient, { clock, wait });
    expect(transient).toHaveBeenCalledTimes(2);
    const hit = await withSourceMemory(dir, ['s1', 'range1'], transient, { clock, wait });
    expect(hit.exitCode).toBe(1);
    expect(hit.value.sourceMemory).toMatchObject({ hit: true });
    expect(transient).toHaveBeenCalledTimes(2);
    now += 16_000;
    await withSourceMemory(dir, ['s1', 'range1'], transient, { clock, wait });
    expect(transient).toHaveBeenCalledTimes(4);
    const bad = vi.fn(async () => ({ exitCode: 1, value: { errorCategory: 'invalid_argument' } }));
    await withSourceMemory(dir, ['s2', 'range1'], bad, { clock, wait });
    expect(bad).toHaveBeenCalledTimes(1);
    await withSourceMemory(dir, ['s2', 'range1'], bad, { clock, refresh: true });
    expect(bad).toHaveBeenCalledTimes(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
