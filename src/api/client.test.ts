import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, apiFetchNdjson } from './client';

describe('apiFetch cancellation and timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the timeout error contract for an internal timeout abort', async () => {
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = apiFetch('/slow', { timeoutMs: 25 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', statusCode: 0 });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/slow'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('combines a caller abort with the internal timeout without mislabeling it', async () => {
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const abortController = new AbortController();
    const pending = apiFetch('/cancel', { signal: abortController.signal, timeoutMs: 25 });
    abortController.abort();

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED', statusCode: 0 });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).not.toBe(abortController.signal);
    await vi.advanceTimersByTimeAsync(25);
  });

  it('preserves regular ApiError responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'bad request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })));

    const pending = apiFetch('/bad');
    await expect(pending).rejects.toBeInstanceOf(ApiError);
  });

  it('parses NDJSON events split across network chunks', async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const events: Array<{ type: string; content?: string }> = [];
    let settled = false;

    const pending = apiFetchNdjson<{ type: string; content?: string }>(
      '/stream',
      { timeoutMs: 1_000 },
      (event) => events.push(event),
    ).finally(() => { settled = true; });
    streamController!.enqueue(encoder.encode('{"type":"delta","content":"交'));
    streamController!.enqueue(encoder.encode('易"}\n'));

    await vi.waitFor(() => expect(events).toEqual([{ type: 'delta', content: '交易' }]));
    expect(settled).toBe(false);

    streamController!.enqueue(encoder.encode('{"type":"done"}\n'));
    streamController!.close();
    await pending;

    expect(events).toEqual([
      { type: 'delta', content: '交易' },
      { type: 'done' },
    ]);
  });
});
