import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from '@/api/config';
import {
  AIServiceError,
  generateStrategy,
  getAIStatus,
} from '../api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI strategy API client', () => {
  it('uses the shared API base URL and forwards abort signals', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      enabled: true,
      configured: true,
      provider: 'openai',
      currentModel: 'test-model',
      availableModels: ['test-model'],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await getAIStatus(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/ai/status`,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('preserves service errors instead of replacing them with mock output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'INVALID_MODEL_OUTPUT',
      message: '模型返回的策略未通过 DSL 校验',
      details: ['entry: invalid'],
    }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    })));

    const request = generateStrategy({
      prompt: '均线策略',
      model: 'test-model',
      dslVersion: '1.0',
    });

    const error = await request.catch((reason) => reason);

    expect(error).toBeInstanceOf(AIServiceError);
    expect(error).toMatchObject({
      name: 'AIServiceError',
      status: 422,
      code: 'INVALID_MODEL_OUTPUT',
      details: ['entry: invalid'],
      message: '模型返回的策略未通过 DSL 校验',
    });
  });
});
