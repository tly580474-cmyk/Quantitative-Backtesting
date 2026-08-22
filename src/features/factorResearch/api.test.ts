import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from '@/api/config';
import { fetchAiModelStatus, interpretFactorRunReport } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('factor research AI API', () => {
  it('reads the shared server model list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      enabled: true,
      configured: true,
      currentModel: 'model-1',
      availableModels: ['model-1', 'model-2'],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAiModelStatus()).resolves.toMatchObject({
      currentModel: 'model-1',
      availableModels: ['model-1', 'model-2'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/ai/status`,
      expect.any(Object),
    );
  });

  it('sends the selected configured model when interpreting a report', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'model-2',
      generatedAt: '2026-08-22T00:00:00.000Z',
      interpretation: 'ok',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await interpretFactorRunReport('run-1', 'model-2');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/factor-runs/run-1/interpret`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'model-2' }),
      }),
    );
  });
});
