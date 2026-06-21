import type { Candle } from '@/models';

/** DJB2-style hash over candle data. Returns hex string. */
export function computeDataChecksum(candles: Candle[]): string {
  let hash = 0;
  for (const c of candles) {
    const s = `${c.time}|${c.open}|${c.high}|${c.low}|${c.close}|${c.volume ?? 0}`;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash |= 0;
    }
  }
  return hash.toString(16);
}

/** Stable hash for a configuration object via JSON-stable-stringify + DJB2. */
export function computeConfigHash(obj: unknown): string {
  const json = JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(16);
}

/** Synchronous combined hash of multiple string components. */
export function computeCombinedHash(components: Record<string, string>): string {
  return computeConfigHash(components);
}
