import { describe, expect, it, vi } from 'vitest';
import { MultiAssetRunDispatcher } from './dispatcher.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('MultiAssetRunDispatcher', () => {
  it('deduplicates run ids and enforces the concurrency limit', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    const dispatcher = new MultiAssetRunDispatcher(async (runId) => {
      started.push(runId);
      await gates[Number(runId.slice(-1)) - 1]!.promise;
    }, undefined, 2);

    expect(dispatcher.enqueue('run-1')).toBe(true);
    expect(dispatcher.enqueue('run-1')).toBe(false);
    expect(dispatcher.enqueue('run-2')).toBe(true);
    expect(dispatcher.enqueue('run-3')).toBe(true);
    await vi.waitFor(() => expect(dispatcher.stats()).toEqual({ active: 2, queued: 1, concurrency: 2 }));
    expect(started).toEqual(['run-1', 'run-2']);

    gates[0]!.resolve();
    await vi.waitFor(() => expect(started).toEqual(['run-1', 'run-2', 'run-3']));
    gates[1]!.resolve();
    gates[2]!.resolve();
    await vi.waitFor(() => expect(dispatcher.stats().active).toBe(0));
  });

  it('reports failures and continues draining the queue', async () => {
    const onError = vi.fn();
    const completed: string[] = [];
    const dispatcher = new MultiAssetRunDispatcher(async (runId) => {
      if (runId === 'bad') throw new Error('boom');
      completed.push(runId);
    }, onError, 1);
    dispatcher.enqueue('bad');
    dispatcher.enqueue('good');
    await vi.waitFor(() => expect(completed).toEqual(['good']));
    expect(onError).toHaveBeenCalledWith('bad', expect.any(Error));
  });

  it('stops accepting and resolves a graceful drain after active work completes', async () => {
    const gate = deferred();
    const dispatcher = new MultiAssetRunDispatcher(async () => gate.promise, undefined, 1);
    dispatcher.enqueue('run-1');
    await vi.waitFor(() => expect(dispatcher.stats().active).toBe(1));
    dispatcher.stopAccepting();
    expect(dispatcher.isAccepting()).toBe(false);
    expect(dispatcher.enqueue('run-2')).toBe(false);
    const draining = dispatcher.drain(1_000);
    gate.resolve();
    await expect(draining).resolves.toBe(true);
  });

  it('reports a drain timeout without cancelling active work', async () => {
    const gate = deferred();
    const dispatcher = new MultiAssetRunDispatcher(async () => gate.promise, undefined, 1);
    dispatcher.enqueue('run-1');
    await vi.waitFor(() => expect(dispatcher.stats().active).toBe(1));
    await expect(dispatcher.drain(5)).resolves.toBe(false);
    expect(dispatcher.stats().active).toBe(1);
    gate.resolve();
  });
});
