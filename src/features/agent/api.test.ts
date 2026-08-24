import { afterEach, describe, expect, it, vi } from 'vitest';
import { continueAgentRun, createAgentRun, normalizeAgentEvent } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent event compatibility adapter', () => {
  it('never exposes legacy thought records', () => {
    expect(normalizeAgentEvent({ eventType: 'thought', content: 'raw reasoning' })).toBeNull();
  });

  it('normalizes v2 public content', () => {
    expect(normalizeAgentEvent({ type: 'assistant_final', publicContent: '结论', seq: 9 }))
      .toMatchObject({ type: 'assistant_final', content: '结论', seq: 9 });
  });
});

describe('agent run request settings', () => {
  it('sends only the prompt and selected provider for a new conversation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: 'run-1', conversationId: 'run-1', status: 'pending',
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await createAgentRun('研究任务', 'codex');

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ prompt: '研究任务', provider: 'codex' });
  });

  it('sends only the prompt when continuing a conversation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: 'run-2', conversationId: 'run-1', status: 'pending', parentRunId: 'run-1',
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await continueAgentRun('run-1', '继续研究');

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ prompt: '继续研究' });
  });
});
