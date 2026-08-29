export const MARKET_HEALTH_INDICATOR_KEYS = ['msh', 'fhi', 'nec', 'vpi'] as const;

export type MarketHealthIndicatorKey = typeof MARKET_HEALTH_INDICATOR_KEYS[number];
export type MarketHealthDirection = 'higher_is_better' | 'higher_is_riskier' | 'cycle_strength';
export type MarketHealthFrequency = 'daily' | 'event' | 'monthly';
export type MarketHealthFreshness = 'current' | 'preliminary' | 'stale' | 'unavailable';
export type MarketHealthPublicationStatus = 'pending' | 'preliminary' | 'published' | 'superseded';

export interface MarketHealthComponent {
  key: string;
  label: string;
  value: number | null;
  score: number | null;
  weight: number;
  source: 'market' | 'financial' | 'macro';
  description: string;
}

export interface MarketHealthHistoryPoint {
  asOfDate: string;
  periodKey: string;
  score: number;
  components: MarketHealthComponent[];
}

export interface MarketHealthIndicator {
  key: MarketHealthIndicatorKey;
  name: string;
  score: number;
  scale: [number, number];
  direction: MarketHealthDirection;
  statusLabel: string;
  interpretation: string;
  frequency: MarketHealthFrequency;
  asOfDate: string;
  periodKey: string;
  calculatedAt: string;
  modelVersion: string;
  coveragePct: number | null;
  freshness: MarketHealthFreshness;
  components: MarketHealthComponent[];
  sourcePeriods: Record<string, string | number | null>;
  history: MarketHealthHistoryPoint[];
}

export interface MarketHealthOverview {
  generatedAt: string;
  indicators: Partial<Record<MarketHealthIndicatorKey, MarketHealthIndicator>>;
}

export interface MarketHealthSnapshotInput {
  indicatorKey: MarketHealthIndicatorKey;
  asOfDate: string;
  periodKey: string;
  score: number;
  statusLabel: string;
  interpretation: string;
  direction: MarketHealthDirection;
  frequency: MarketHealthFrequency;
  modelVersion: string;
  components: MarketHealthComponent[];
  sourcePeriods: Record<string, string | number | null>;
  coveragePct: number | null;
  sourceSnapshotId: string | null;
  calculatedAt: string;
  publicationStatus: Extract<MarketHealthPublicationStatus, 'preliminary' | 'published'>;
  staleAfter: string | null;
}
