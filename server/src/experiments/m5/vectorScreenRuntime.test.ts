import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVectorScreen } from './vectorScreenRuntime.js';

describe('M5 vector screen runtime', () => {
  const request = {
    runtime: 'numpy_reference' as const,
    specHash: 'a'.repeat(64),
    datasetHash: 'b'.repeat(64),
    close: Array.from({ length: 80 }, (_, index) => 100 + index + Math.sin(index) * 2),
    parameterGrid: [{ fast: 5, slow: 20 }, { fast: 10, slow: 30 }],
  };

  it('is disabled unless explicitly enabled', async () => {
    await expect(runVectorScreen({ request, enabled: false, pythonExecutable: 'python' }))
      .rejects.toThrow('VECTOR_SCREEN_RUNTIME_DISABLED');
  });

  it('emits screening-only candidates bound to spec and dataset hashes', async () => {
    const candidates = await runVectorScreen({
      request,
      enabled: true,
      pythonExecutable: 'python',
      workerPath: resolve('../tools/vector-screen/worker.py'),
    });
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.authority === 'screening_only')).toBe(true);
    expect(candidates.every((candidate) => candidate.specHash === request.specHash)).toBe(true);
  });
});
