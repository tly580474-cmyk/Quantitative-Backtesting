import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from './marketNewsScheduler.js';

afterEach(() => vi.useRealTimers());

describe('market news scheduler timeout', () => {
  it('returns a completed collector result', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100, 'timeout')).resolves.toBe('ok');
  });

  it('fails a collector that exceeds its execution budget', async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise<never>(() => undefined), 100, '新闻采集超时');
    const rejection = expect(result).rejects.toThrow('新闻采集超时');
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
  });
});
