import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMonthlySelectionStore } from './monthlySelectionStore.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'monthly-selection-'));
  roots.push(root);
  const file = join(root, 'results.json');
  const result = { dataAsOf: '2026-09-21', batches: ['08', '07', '06'] };
  const build = vi.fn(async () => result);
  const sourceMonth = vi.fn(async () => '2026-09');
  const options = { now: new Date('2026-09-21T03:00:00Z'), build, sourceMonth };
  return { file, result, options };
}

describe('durable monthly selection results', () => {
  it('reuses disk results after restart without reading any snapshot', async () => {
    const { file, result, options } = await setup();
    await createMonthlySelectionStore()(file, options);
    const restarted = createMonthlySelectionStore();
    expect(await restarted(file, options)).toEqual(result);
    expect(options.build).toHaveBeenCalledTimes(1);
    expect(options.sourceMonth).not.toHaveBeenCalled();
  });
  it('waits for new-month data, then rolls to the latest three results', async () => {
    const { file, options } = await setup();
    const store = createMonthlySelectionStore();
    await store(file, options);
    options.now = new Date('2026-09-30T16:00:00Z'); // October in Shanghai
    await store(file, options);
    expect(options.build).toHaveBeenCalledTimes(1);
    options.sourceMonth.mockResolvedValue('2026-10');
    options.build.mockResolvedValue({ dataAsOf: '2026-10-09', batches: ['09', '08', '07'] });
    expect((await store(file, options)).batches).toEqual(['09', '08', '07']);
    expect(JSON.parse(await readFile(file, 'utf8')).result.batches).toHaveLength(3);
    expect(options.build).toHaveBeenCalledTimes(2);
  });
  it('deduplicates simultaneous forced refreshes and preserves results on failure', async () => {
    const { file, result, options } = await setup();
    const store = createMonthlySelectionStore();
    await Promise.all([store(file, options), store(file, options)]);
    expect(options.build).toHaveBeenCalledTimes(1);
    await Promise.all([store(file, { ...options, force: true }), store(file, { ...options, force: true })]);
    expect(options.build).toHaveBeenCalledTimes(2);
    options.build.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await expect(store(file, { ...options, force: true })).rejects.toThrow('snapshot unavailable');
    expect(await store(file, options)).toEqual(result);
  });
  it('isolates results by storage root and selection size', async () => {
    const first = await setup(), second = await setup();
    const store = createMonthlySelectionStore();
    await store(first.file, first.options);
    await store(second.file, second.options);
    expect(second.options.build).toHaveBeenCalledTimes(1);
  });
});
