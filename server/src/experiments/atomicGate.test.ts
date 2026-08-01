import { describe, expect, it } from 'vitest';
import { claimAtomicGate } from './atomicGate.js';

describe('distributed atomic gate contract', () => {
  it('allows exactly one token under concurrent callers', async () => {
    let status: 'sealed' | 'opened' = 'sealed';
    let storedToken: string | null = null;
    const adapter = {
      read: async () => ({ status, token: storedToken, value: { status, token: storedToken } }),
      compareAndSet: async (token: string) => {
        // Mirrors UPDATE ... WHERE status = 'sealed': this synchronous section
        // represents the database row lock/CAS decision.
        if (status !== 'sealed') return false;
        status = 'opened';
        storedToken = token;
        return true;
      },
    };
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) => claimAtomicGate(adapter, `token-${index}`)),
    );
    expect(results.filter((result) => result.type === 'opened')).toHaveLength(1);
    expect(results.filter((result) => result.type === 'already_opened')).toHaveLength(31);
  });

  it('makes a retry with the winning token idempotent', async () => {
    const adapter = {
      read: async () => ({ status: 'opened' as const, token: 'winner', value: 1 }),
      compareAndSet: async () => false,
    };
    await expect(claimAtomicGate(adapter, 'winner')).resolves.toMatchObject({ type: 'opened', reused: true });
  });
});
