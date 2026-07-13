import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

export interface ManagedDuckDBSession {
  connection: Awaited<ReturnType<DuckDBInstance['connect']>>;
  tempDirectory: string;
  close(): Promise<void>;
}

export interface OpenManagedDuckDBOptions {
  label: string;
  config?: Record<string, string>;
  tempRoot?: string;
}

let activeSessions = 0;
const waiters: Array<() => void> = [];

export async function openManagedDuckDB(
  options: OpenManagedDuckDBOptions,
): Promise<ManagedDuckDBSession> {
  const releaseSlot = await acquireSlot();
  const configuredRoot = options.tempRoot ?? process.env.DUCKDB_TEMP_ROOT?.trim();
  const root = resolve(configuredRoot || join(tmpdir(), 'quant-backtest-duckdb'));
  await mkdir(root, { recursive: true });
  const label = options.label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'query';
  const tempDirectory = await mkdtemp(join(root, `${label}-`));
  let instance: DuckDBInstance | undefined;
  try {
    instance = await DuckDBInstance.create(':memory:', {
      access_mode: 'READ_WRITE',
      max_temp_directory_size: process.env.DUCKDB_MAX_TEMP_SIZE ?? '50GB',
      ...options.config,
      temp_directory: normalizePath(tempDirectory),
    });
    const connection = await instance.connect();
    let closed = false;
    return {
      connection,
      tempDirectory,
      async close() {
        if (closed) return;
        closed = true;
        try {
          try {
            connection.closeSync();
          } finally {
            instance!.closeSync();
          }
        } finally {
          await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
          releaseSlot();
        }
      },
    };
  } catch (error) {
    try {
      instance?.closeSync();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
      releaseSlot();
    }
    throw error;
  }
}

export function getDuckDBRuntimeStats(): { active: number; queued: number; limit: number } {
  return { active: activeSessions, queued: waiters.length, limit: concurrencyLimit() };
}

async function acquireSlot(): Promise<() => void> {
  if (activeSessions >= concurrencyLimit()) {
    await new Promise<void>((resolveWaiter) => waiters.push(resolveWaiter));
  } else {
    activeSessions += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) next();
    else activeSessions = Math.max(0, activeSessions - 1);
  };
}

function concurrencyLimit(): number {
  const parsed = Number.parseInt(process.env.DUCKDB_MAX_CONCURRENT ?? '2', 10);
  return Number.isFinite(parsed) ? Math.min(8, Math.max(1, parsed)) : 2;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
