import { describe, expect, it } from 'vitest';
import { canManageMiningTask } from './candidateRepository.js';

describe('mining task lifecycle management', () => {
  it.each(['completed', 'failed', 'canceled'])('allows terminal status %s', (status) => {
    expect(canManageMiningTask(status)).toBe(true);
  });

  it.each(['pending', 'running'])('rejects active status %s', (status) => {
    expect(canManageMiningTask(status)).toBe(false);
  });
});
