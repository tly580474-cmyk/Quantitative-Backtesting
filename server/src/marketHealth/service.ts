import { listLatestPublishedMarketHealthSnapshots, type StoredMarketHealthSnapshot } from './repository.js';
import type {
  MarketHealthFreshness,
  MarketHealthIndicator,
  MarketHealthIndicatorKey,
  MarketHealthOverview,
} from './types.js';

const NAMES: Record<MarketHealthIndicatorKey, string> = {
  msh: '市场结构',
  fhi: '盈利承载',
  nec: '名义盈利周期',
  vpi: '估值压力',
};

let cache: { value: MarketHealthOverview; expiresAt: number } | null = null;
const CACHE_MS = 60_000;

export async function getMarketHealthOverview(force = false): Promise<MarketHealthOverview> {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.value;
  const snapshots = await listLatestPublishedMarketHealthSnapshots();
  const generatedAt = new Date().toISOString();
  const indicators: MarketHealthOverview['indicators'] = {};
  for (const snapshot of snapshots) {
    indicators[snapshot.indicatorKey] = presentSnapshot(snapshot, generatedAt);
  }
  const value = { generatedAt, indicators };
  cache = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

export function invalidateMarketHealthCache(): void {
  cache = null;
}

export function presentSnapshot(snapshot: StoredMarketHealthSnapshot, nowIso: string): MarketHealthIndicator {
  return {
    key: snapshot.indicatorKey,
    name: NAMES[snapshot.indicatorKey],
    score: clampScore(snapshot.score),
    scale: [0, 100],
    direction: snapshot.direction,
    statusLabel: snapshot.statusLabel,
    interpretation: snapshot.interpretation,
    frequency: snapshot.frequency,
    asOfDate: snapshot.asOfDate,
    periodKey: snapshot.periodKey,
    calculatedAt: snapshot.calculatedAt,
    modelVersion: snapshot.modelVersion,
    coveragePct: snapshot.coveragePct,
    freshness: resolveFreshness(snapshot, nowIso),
    components: snapshot.components,
    sourcePeriods: snapshot.sourcePeriods,
  };
}

export function resolveFreshness(snapshot: StoredMarketHealthSnapshot, nowIso: string): MarketHealthFreshness {
  if (snapshot.publicationStatus === 'preliminary') return 'preliminary';
  if (snapshot.staleAfter && Date.parse(nowIso) > Date.parse(snapshot.staleAfter)) return 'stale';
  return 'current';
}

function clampScore(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}
