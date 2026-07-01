import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type HotSectorType = 'industry' | 'concept';

export interface HotSectorSourceRow {
  code: string;
  name: string;
  type: HotSectorType;
  changePct: number | null;
  amountYi: number | null;
  mainNetInYi: number | null;
  mainNetRatio: number | null;
  advancers: number | null;
  decliners: number | null;
  leadingStock: string | null;
  leadingStockChangePct: number | null;
}

export interface HotSectorItem extends HotSectorSourceRow {
  rank: number;
  heatScore: number;
  breadthPct: number | null;
  signals: string[];
  scoreDetail: {
    momentum: number;
    capital: number;
    breadth: number;
    activity: number;
    persistence: number;
  };
}

export interface HotSectorSnapshot {
  items: HotSectorItem[];
  updatedAt: string;
  total: number;
  source: string;
}

const CACHE_MS = 5 * 60_000;
const serverRoot = process.cwd().replace(/[\\/]server$/, '') === process.cwd()
  ? resolve(process.cwd(), 'server')
  : process.cwd();
function localModulePath(relativeUrl: string, fallbackFromServerRoot: string): string {
  try {
    return fileURLToPath(new URL(relativeUrl, import.meta.url));
  } catch {
    return resolve(serverRoot, fallbackFromServerRoot);
  }
}
const CACHE_FILE = localModulePath('../../.cache/hot-sectors.json', '.cache/hot-sectors.json');
const ENDPOINTS = [
  'https://push2.eastmoney.com/api/qt/clist/get',
  'https://82.push2.eastmoney.com/api/qt/clist/get',
];

let memoryCache: { data: HotSectorSnapshot; cachedAt: number } | null = null;
let refreshInFlight: Promise<HotSectorSnapshot> | null = null;

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], value: number | null): number {
  if (value == null || values.length <= 1) return 0;
  const below = values.filter((item) => item < value).length;
  const equal = values.filter((item) => item === value).length;
  return ((below + Math.max(0, equal - 1) / 2) / (values.length - 1)) * 100;
}

export function scoreHotSectorRows(
  rows: HotSectorSourceRow[],
  previousItems: HotSectorItem[] = [],
): HotSectorItem[] {
  const metricsByType = new Map<HotSectorType, {
    change: number[];
    net: number[];
    ratio: number[];
    amount: number[];
    breadth: number[];
  }>();
  for (const type of ['industry', 'concept'] as const) {
    const peers = rows.filter((item) => item.type === type);
    metricsByType.set(type, {
      change: peers.flatMap((item) => item.changePct == null ? [] : [item.changePct]),
      net: peers.flatMap((item) => item.mainNetInYi == null ? [] : [item.mainNetInYi]),
      ratio: peers.flatMap((item) => item.mainNetRatio == null ? [] : [item.mainNetRatio]),
      amount: peers.flatMap((item) => item.amountYi == null ? [] : [item.amountYi]),
      breadth: peers.flatMap((item) => {
        const total = (item.advancers ?? 0) + (item.decliners ?? 0);
        return total > 0 ? [((item.advancers ?? 0) / total) * 100] : [];
      }),
    });
  }
  const previousRanks = new Map(previousItems.map((item) => [`${item.type}:${item.code}`, item.rank]));

  return rows.map((row) => {
    const metrics = metricsByType.get(row.type)!;
    const total = (row.advancers ?? 0) + (row.decliners ?? 0);
    const breadthPct = total > 0 ? round(((row.advancers ?? 0) / total) * 100) : null;
    const momentum = percentile(metrics.change, row.changePct);
    const capital = percentile(metrics.net, row.mainNetInYi) * 0.55
      + percentile(metrics.ratio, row.mainNetRatio) * 0.45;
    const breadth = percentile(metrics.breadth, breadthPct);
    const activity = percentile(metrics.amount, row.amountYi);
    const previousRank = previousRanks.get(`${row.type}:${row.code}`);
    const persistence = previousRank == null ? 50 : previousRank <= 20 ? 100 : previousRank <= 50 ? 70 : 35;
    const heatScore = round(
      momentum * 0.3 + capital * 0.25 + breadth * 0.2 + activity * 0.15 + persistence * 0.1,
      1,
    );
    const signals: string[] = [];
    if (momentum >= 80) signals.push('涨幅领先');
    if ((row.mainNetInYi ?? 0) > 0 && (row.mainNetRatio ?? 0) > 0) signals.push('资金流入');
    if ((breadthPct ?? 0) >= 65) signals.push('板块普涨');
    if (persistence === 100) signals.push('热度延续');
    return {
      ...row,
      rank: 0,
      heatScore,
      breadthPct,
      signals,
      scoreDetail: {
        momentum: round(momentum, 1),
        capital: round(capital, 1),
        breadth: round(breadth, 1),
        activity: round(activity, 1),
        persistence,
      },
    };
  })
    .sort((a, b) => b.heatScore - a.heatScore || (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

async function fetchBoardRows(type: HotSectorType): Promise<HotSectorSourceRow[]> {
  const params = new URLSearchParams({
    fid: 'f62',
    po: '1',
    pz: '500',
    pn: '1',
    np: '1',
    fltt: '2',
    invt: '2',
    fs: type === 'industry' ? 'm:90+t:2' : 'm:90+t:3',
    fields: 'f3,f6,f12,f14,f62,f104,f105,f128,f136,f184',
  });
  let lastError: unknown;
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}?${params.toString()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          Referer: 'https://quote.eastmoney.com/',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`板块接口 HTTP ${response.status}`);
      const payload = await response.json() as { data?: { diff?: Array<Record<string, unknown>> } };
      const rows = payload.data?.diff ?? [];
      if (rows.length === 0) throw new Error('板块接口返回空数据');
      return rows.flatMap((row) => {
        const code = String(row.f12 ?? '').trim();
        const name = String(row.f14 ?? '').trim();
        if (!code || !name) return [];
        const amount = finite(row.f6);
        const mainNet = finite(row.f62);
        return [{
          code,
          name,
          type,
          changePct: finite(row.f3),
          amountYi: amount == null ? null : round(amount / 100_000_000),
          mainNetInYi: mainNet == null ? null : round(mainNet / 100_000_000),
          mainNetRatio: finite(row.f184),
          advancers: finite(row.f104),
          decliners: finite(row.f105),
          leadingStock: row.f128 == null ? null : String(row.f128),
          leadingStockChangePct: finite(row.f136),
        }];
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('板块数据源暂不可用');
}

async function readDiskCache(): Promise<{ data: HotSectorSnapshot; cachedAt: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as {
      data?: HotSectorSnapshot;
      cachedAt?: number;
    };
    if (parsed.data?.items?.length && Number.isFinite(parsed.cachedAt)) {
      return { data: parsed.data, cachedAt: Number(parsed.cachedAt) };
    }
  } catch {
    // First run has no persisted snapshot.
  }
  return null;
}

async function refreshHotSectors(): Promise<HotSectorSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const [industry, concept] = await Promise.all([
      fetchBoardRows('industry'),
      fetchBoardRows('concept'),
    ]);
    const data: HotSectorSnapshot = {
      items: scoreHotSectorRows([...industry, ...concept], memoryCache?.data.items ?? []),
      updatedAt: new Date().toISOString(),
      total: industry.length + concept.length,
      source: '东方财富行业/概念板块',
    };
    const cachedAt = Date.now();
    memoryCache = { data, cachedAt };
    await mkdir(resolve(CACHE_FILE, '..'), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ data, cachedAt }), 'utf8').catch(() => undefined);
    return data;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export async function fetchCachedHotSectors(force = false): Promise<HotSectorSnapshot> {
  if (!force && memoryCache && Date.now() - memoryCache.cachedAt < CACHE_MS) return memoryCache.data;
  if (!force && !memoryCache) memoryCache = await readDiskCache();
  if (!force && memoryCache) {
    if (Date.now() - memoryCache.cachedAt >= CACHE_MS && !refreshInFlight) {
      void refreshHotSectors().catch(() => undefined);
    }
    return memoryCache.data;
  }
  return refreshHotSectors();
}
