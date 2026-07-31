import { createHash } from 'node:crypto';

interface LockConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  release(): void;
}

interface LockPool {
  getConnection(): Promise<LockConnection>;
}

export class DistributedLockUnavailableError extends Error {
  constructor(public readonly lockName: string) {
    super('该资源正在由其他服务实例处理');
    this.name = 'DistributedLockUnavailableError';
  }
}

export function mysqlAdvisoryLockName(resource: string): string {
  const digest = createHash('sha256').update(resource).digest('hex');
  return `quant:${digest.slice(0, 58)}`;
}

function firstNumericValue(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const first = rows[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return 0;
  const value = Object.values(first as Record<string, unknown>)[0];
  return Number(value ?? 0);
}

/**
 * Runs a short critical section under a MySQL advisory lock.
 *
 * The same pooled connection must acquire and release GET_LOCK. This lock is
 * for the atomic "open locked test" transition, not for the full long-running
 * research job.
 */
export async function withMysqlDistributedLock<T>(
  pool: LockPool,
  resource: string,
  timeoutSeconds: number,
  work: () => Promise<T>,
): Promise<T> {
  const connection = await pool.getConnection();
  const lockName = mysqlAdvisoryLockName(resource);
  let acquired = false;
  try {
    const [rows] = await connection.query(
      'SELECT GET_LOCK(?, ?) AS acquired',
      [lockName, Math.max(0, Math.trunc(timeoutSeconds))],
    );
    acquired = firstNumericValue(rows) === 1;
    if (!acquired) throw new DistributedLockUnavailableError(lockName);
    return await work();
  } finally {
    if (acquired) {
      try {
        await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
      } finally {
        connection.release();
      }
    } else {
      connection.release();
    }
  }
}
