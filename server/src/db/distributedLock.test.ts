import { describe, expect, it } from 'vitest';
import {
  DistributedLockUnavailableError,
  mysqlAdvisoryLockName,
  withMysqlDistributedLock,
} from './distributedLock.js';

class FakeLockPool {
  readonly held = new Set<string>();
  releases = 0;

  async getConnection() {
    return {
      query: async (sql: string, values?: unknown[]): Promise<[unknown, unknown]> => {
        const lockName = String(values?.[0] ?? '');
        if (sql.includes('GET_LOCK')) {
          if (this.held.has(lockName)) return [[{ acquired: 0 }], []];
          this.held.add(lockName);
          return [[{ acquired: 1 }], []];
        }
        if (sql.includes('RELEASE_LOCK')) {
          const released = this.held.delete(lockName) ? 1 : 0;
          return [[{ released }], []];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      release: () => {
        this.releases += 1;
      },
    };
  }
}

describe('withMysqlDistributedLock', () => {
  it('uses a stable MySQL-safe lock name', () => {
    const first = mysqlAdvisoryLockName('locked-test:candidate-1');
    expect(first).toBe(mysqlAdvisoryLockName('locked-test:candidate-1'));
    expect(first).not.toBe(mysqlAdvisoryLockName('locked-test:candidate-2'));
    expect(first.length).toBeLessThanOrEqual(64);
  });

  it('allows only one concurrent opener for the same locked test', async () => {
    const pool = new FakeLockPool();
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });

    const first = withMysqlDistributedLock(
      pool,
      'locked-test:candidate-1',
      0,
      async () => {
        markFirstEntered();
        await firstMayFinish;
        return 'opened';
      },
    );
    await firstEntered;

    await expect(withMysqlDistributedLock(
      pool,
      'locked-test:candidate-1',
      0,
      async () => 'duplicate',
    )).rejects.toBeInstanceOf(DistributedLockUnavailableError);

    releaseFirst();
    await expect(first).resolves.toBe('opened');
    expect(pool.held.size).toBe(0);
    expect(pool.releases).toBe(2);
  });

  it('releases the lock when the critical section fails', async () => {
    const pool = new FakeLockPool();
    await expect(withMysqlDistributedLock(
      pool,
      'locked-test:candidate-1',
      0,
      async () => {
        throw new Error('transition failed');
      },
    )).rejects.toThrow('transition failed');

    await expect(withMysqlDistributedLock(
      pool,
      'locked-test:candidate-1',
      0,
      async () => 'retry',
    )).resolves.toBe('retry');
  });
});
