import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { calculateLatestNominalEarningsCycle } from '../calculation/nominalEarningsCycle.js';
import {
  insertMacroObservationVersion,
  listLatestAvailableMacroObservations,
  type MacroObservationInput,
} from '../macroRepository.js';
import { getLatestMarketHealthSnapshot, publishMarketHealthSnapshot } from '../repository.js';
import { invalidateMarketHealthCache } from '../service.js';

const execFileAsync = promisify(execFile);

interface PpiPayload {
  akshareVersion: string;
  retrievalUrl: string;
  authorityKey: string;
  items: Array<{ observationPeriod: string; value: number; availableAt: string }>;
}

export async function refreshNominalEarningsCycle(pythonExecutable = 'python'): Promise<{
  fetched: number;
  inserted: number;
  publishedPeriod: string | null;
}> {
  const script = fileURLToPath(new URL('../akshare_ppi.py', import.meta.url));
  const { stdout } = await execFileAsync(pythonExecutable, [script], {
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const payload = parsePayload(stdout);
  const fetchedAt = new Date().toISOString();
  let inserted = 0;
  for (const item of payload.items) {
    const input: MacroObservationInput = {
      seriesKey: 'ppi_yoy',
      observationPeriod: item.observationPeriod,
      value: item.value,
      publishedAt: null,
      availableAt: item.availableAt,
      fetchedAt,
      sourceKey: `akshare-${payload.akshareVersion}`,
      authorityKey: payload.authorityKey,
      sourceUrl: payload.retrievalUrl,
      sourceChecksum: createHash('sha256')
        .update(JSON.stringify([item.observationPeriod, item.value, payload.retrievalUrl]))
        .digest('hex'),
      status: 'observed',
    };
    if (await insertMacroObservationVersion(input)) inserted += 1;
  }

  const observations = await listLatestAvailableMacroObservations('ppi_yoy', fetchedAt);
  const snapshot = calculateLatestNominalEarningsCycle(observations, new Date(fetchedAt));
  const existing = await getLatestMarketHealthSnapshot('nec');
  const needsPublication = snapshot && (
    !existing
    || inserted > 0
    || existing.periodKey !== snapshot.periodKey
    || existing.modelVersion !== snapshot.modelVersion
  );
  if (snapshot && needsPublication) {
    await publishMarketHealthSnapshot(snapshot);
    invalidateMarketHealthCache();
  }
  return { fetched: payload.items.length, inserted, publishedPeriod: snapshot?.periodKey ?? null };
}

function parsePayload(stdout: string): PpiPayload {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const payload = JSON.parse(lines.at(-1) ?? '{}') as Partial<PpiPayload>;
  if (!payload.akshareVersion || !payload.retrievalUrl || !payload.authorityKey || !Array.isArray(payload.items)) {
    throw new Error('AKShare PPI 输出结构无效');
  }
  return payload as PpiPayload;
}
