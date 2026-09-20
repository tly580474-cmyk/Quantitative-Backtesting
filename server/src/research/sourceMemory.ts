import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface ResearchOutcome { value: Record<string, unknown>; exitCode: number; }
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export function outcomeTtl(outcome: ResearchOutcome): number {
  if (outcome.value.status === 'unsupported') return 300_000;
  if (outcome.exitCode) return outcome.value.errorCategory === 'upstream_unavailable' ? 15_000 : 60_000;
  if (outcome.value.usable === false || outcome.value.available === false) return 15_000;
  return 30_000; // Live database data must not inherit immutable snapshot TTLs.
}
export async function withSourceMemory(
  directory: string, scope: unknown, execute: () => Promise<ResearchOutcome>,
  options: { refresh?: boolean; clock?: () => number; wait?: (ms: number) => Promise<void> } = {},
): Promise<ResearchOutcome> {
  const clock = options.clock ?? Date.now;
  const key = fingerprint(scope);
  const path = join(directory, `${key}.json`);
  if (!options.refresh) {
    try {
      const cache = JSON.parse(await readFile(path, 'utf8'));
      if (cache.version === 1 && cache.key === key && cache.expiresAt > clock() && cache.savedAt <= clock()) {
        return { ...cache.outcome, value: { ...cache.outcome.value, sourceMemory: {
          hit: true, savedAt: new Date(cache.savedAt).toISOString(), expiresAt: new Date(cache.expiresAt).toISOString(),
          next: '命中短期同参数记录；修正参数或更换范围会重新执行，确认条件变化可加 --refresh。',
        } } };
      }
    } catch { /* Missing/corrupt memory cannot block authoritative reads. */ }
  }
  let outcome = await execute();
  let attempts = 1;
  if (outcome.exitCode && outcome.value.errorCategory === 'upstream_unavailable') {
    await (options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000);
    outcome = await execute(); attempts++;
  }
  outcome = { ...outcome, value: { ...outcome.value, sourceMemory: { hit: false, attempts } } };
  const savedAt = clock();
  const data = JSON.stringify({ version: 1, key, savedAt, expiresAt: savedAt + outcomeTtl(outcome), outcome });
  if (Buffer.byteLength(data) <= 512 * 1024) {
    try {
      await mkdir(directory, { recursive: true });
      const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      // Bound disk use even when the caller continually changes queries.
      if (files.length >= 256) await Promise.all(files.slice(0, files.length - 255).map(name => rm(join(directory, name), { force: true })));
      const temporary = `${path}.${randomUUID()}.partial`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, path);
    } catch { /* Best effort cache; never changes successful query status. */ }
  }
  return outcome;
}
