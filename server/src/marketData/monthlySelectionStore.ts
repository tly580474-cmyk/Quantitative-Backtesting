import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

interface MonthlyResult { dataAsOf: string; batches: unknown[] }

/** One durable result per strategy/size, independent of daily snapshot IDs. */
export function createMonthlySelectionStore<T extends MonthlyResult>() {
  const pending = new Map<string, Promise<T>>();
  return async (file: string, options: {
    force?: boolean;
    now?: Date;
    sourceMonth: () => Promise<string>;
    build: () => Promise<T>;
  }): Promise<T> => {
    const existing = pending.get(file);
    if (existing) return existing;
    const task = (async () => {
      let saved: T | undefined;
      try {
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (value.version === 1 && /^\d{4}-\d{2}-\d{2}$/.test(value.result?.dataAsOf)
          && Array.isArray(value.result.batches) && value.result.batches.length > 0
          && value.result.batches.length <= 3) saved = value.result;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (saved && !options.force) {
        const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
          .format(options.now ?? new Date()).slice(0, 7);
        // Ordinary visits never open a research snapshot, including after restart.
        if (saved.dataAsOf.slice(0, 7) >= month) return saved;
        // At rollover wait for a snapshot in the new month before selecting again.
        if (await options.sourceMonth() <= saved.dataAsOf.slice(0, 7)) return saved;
      }
      const result = await options.build();
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, result }), 'utf8');
      await rename(temporary, file);
      return result;
    })();
    pending.set(file, task);
    try { return await task; } finally { pending.delete(file); }
  };
}
