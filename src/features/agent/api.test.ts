import { afterEach, describe, expect, it, vi } from 'vitest';
import { continueAgentRun, createAgentRun, deleteAgentConversation, normalizeAgentEvent, retryAgentRun } from './api';

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
  it('sends the prompt, selected provider and attachment ids for a new conversation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: 'run-1', conversationId: 'run-1', status: 'pending',
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await createAgentRun('研究任务', 'codex', ['attachment-1']);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      prompt: '研究任务', provider: 'codex', attachmentIds: ['attachment-1'],
    });
  });

  it('sends the prompt and attachment ids when continuing a conversation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: 'run-2', conversationId: 'run-1', status: 'pending', parentRunId: 'run-1',
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await continueAgentRun('run-1', '继续研究', ['attachment-2']);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ prompt: '继续研究', attachmentIds: ['attachment-2'] });
  });

  it('deletes an entire conversation instead of one run', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ deletedRuns: 3 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteAgentConversation('conversation-1');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/agent/conversations/conversation-1'),
      expect.objectContaining({ method: 'DELETE' }));
  });

  it('retries only through the explicit retry endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: 'run-2', conversationId: 'conversation-1', parentRunId: 'run-1', status: 'pending', prompt: '重试任务',
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await retryAgentRun('run-1');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/agent/runs/run-1/retry'),
      expect.objectContaining({ method: 'POST' }));
  });
});
