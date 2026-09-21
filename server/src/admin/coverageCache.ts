import type { CoverageMatrix } from '../research/dataCoverageMatrix.js';

const TTL_MS = 15 * 60_000;
const RETRY_MS = 60_000;

/** A cold/expired coverage scan must never hold the overview HTTP response open. */
export function createAdminCoverageReader(deps: {
  read: (maxAgeMs: number) => Promise<CoverageMatrix | null>;
  rebuild: () => Promise<CoverageMatrix>;
}) {
  let inFlight: Promise<void> | null = null;
  let latest: CoverageMatrix | null = null;
  let expiresAt = 0;
  let retryAfter = 0;
  let failed = false;
  const usable = (value: CoverageMatrix | null) => value?.rows.some(row => row.key === 'dragon_tiger') ? value : null;

  return async () => {
    const fresh = Date.now() < expiresAt ? latest : usable(await deps.read(TTL_MS));
    if (fresh) {
      latest = fresh;
      return { matrix: fresh, refreshing: false, failed: false };
    }
    const stale = latest ?? usable(await deps.read(Infinity));
    if (!inFlight && Date.now() >= retryAfter) {
      failed = false;
      inFlight = Promise.resolve().then(deps.rebuild).then(matrix => {
        latest = matrix;
        expiresAt = Date.now() + TTL_MS;
      }).catch(() => {
        failed = true;
        retryAfter = Date.now() + RETRY_MS;
      }).finally(() => { inFlight = null; });
    }
    return { matrix: stale, refreshing: inFlight !== null, failed };
  };
}
