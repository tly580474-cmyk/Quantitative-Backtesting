import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MarketCapitalFlowSnapshot {
  mainNetInYi: number;
  sampleCount: number;
  total: number;
  coveragePct: number;
  updatedAt: string;
  tradeDate: string | null;
  source: string;
  stale?: boolean;
  fallbackReason?: string;
}

const CACHE_MS = 15 * 60_000;
const PAGE_SIZE = 100;
const CONCURRENCY = 6;
const serverRoot = process.cwd().replace(/[\\/]server$/, '') === process.cwd()
  ? resolve(process.cwd(), 'server')
  : process.cwd();
const CACHE_FILE = (() => {
  try {
    return fileURLToPath(new URL('../../.cache/market-capital-flow.json', import.meta.url));
  } catch {
    return resolve(serverRoot, '.cache/market-capital-flow.json');
  }
})();
const ENDPOINTS = [
  'https://push2delay.eastmoney.com/api/qt/clist/get',
  'https://push2.eastmoney.com/api/qt/clist/get',
  'https://82.push2.eastmoney.com/api/qt/clist/get',
  'https://7.push2.eastmoney.com/api/qt/clist/get',
  'https://48.push2.eastmoney.com/api/qt/clist/get',
];

let memoryCache: { data: MarketCapitalFlowSnapshot; cachedAt: number } | null = null;
let refreshInFlight: Promise<MarketCapitalFlowSnapshot> | null = null;

function params(page: number): URLSearchParams {
  return new URLSearchParams({
    fid: 'f62', po: '1', pz: String(PAGE_SIZE), pn: String(page), np: '1', fltt: '2', invt: '2',
    fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23',
    fields: 'f12,f14,f62',
  });
}

async function fetchPage(page: number): Promise<{ total: number; rows: Array<Record<string, unknown>> }> {
  let lastError: unknown;
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}?${params(page)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          Referer: 'https://quote.eastmoney.com/',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`全市场资金流接口 HTTP ${response.status}`);
      const payload = await response.json() as { data?: { total?: number; diff?: Array<Record<string, unknown>> } };
      const rows = payload.data?.diff ?? [];
      const total = Number(payload.data?.total ?? 0);
      if (!rows.length || !Number.isFinite(total) || total <= 0) throw new Error('全市场资金流接口返回空数据');
      return { total, rows };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('全市场资金流数据源暂不可用');
}

export function aggregateMarketCapitalFlow(
  rows: Array<Record<string, unknown>>,
  total: number,
): Pick<MarketCapitalFlowSnapshot, 'mainNetInYi' | 'sampleCount' | 'total' | 'coveragePct'> {
  const seen = new Set<string>();
  let mainNetInYuan = 0;
  let sampleCount = 0;
  for (const row of rows) {
    const code = String(row.f12 ?? '').trim();
    const value = row.f62 == null || row.f62 === ''
      ? Number.NaN
      : typeof row.f62 === 'number' ? row.f62 : Number(row.f62);
    if (!/^\d{6}$/.test(code) || seen.has(code) || !Number.isFinite(value)) continue;
    seen.add(code);
    mainNetInYuan += value;
    sampleCount += 1;
  }
  const coveragePct = total > 0 ? Math.round(sampleCount / total * 10_000) / 100 : 0;
  return {
    mainNetInYi: Math.round(mainNetInYuan / 1_000_000) / 100,
    sampleCount,
    total,
    coveragePct,
  };
}

async function readDiskCache(): Promise<{ data: MarketCapitalFlowSnapshot; cachedAt: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as {
      data?: MarketCapitalFlowSnapshot;
      cachedAt?: number;
    };
    if (parsed.data && parsed.data.sampleCount > 500 && Number.isFinite(parsed.cachedAt)) {
      return { data: parsed.data, cachedAt: Number(parsed.cachedAt) };
    }
  } catch {
    // First run has no persisted snapshot.
  }
  return null;
}

async function refreshMarketCapitalFlow(tradeDate: string | null): Promise<MarketCapitalFlowSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const first = await fetchPage(1);
    const pageCount = Math.ceil(first.total / PAGE_SIZE);
    const rows = [...first.rows];
    let cursor = 2;
    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(pageCount - 1, 0)) }, async () => {
      const workerRows: Array<Record<string, unknown>> = [];
      while (cursor <= pageCount) {
        const page = cursor++;
        workerRows.push(...(await fetchPage(page)).rows);
      }
      return workerRows;
    });
    rows.push(...(await Promise.all(workers)).flat());
    const aggregate = aggregateMarketCapitalFlow(rows, first.total);
    if (aggregate.coveragePct < 80) throw new Error(`全市场资金流覆盖率不足：${aggregate.coveragePct}%`);
    const data: MarketCapitalFlowSnapshot = {
      ...aggregate,
      updatedAt: new Date().toISOString(),
      tradeDate,
      source: '东方财富 A 股个股主力净流入汇总',
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

export async function fetchCachedMarketCapitalFlow(
  force = false,
  tradeDate: string | null = null,
): Promise<MarketCapitalFlowSnapshot> {
  if (!memoryCache) memoryCache = await readDiskCache();
  if (!force && memoryCache && Date.now() - memoryCache.cachedAt < CACHE_MS) return memoryCache.data;
  try {
    return await refreshMarketCapitalFlow(tradeDate);
  } catch (error) {
    if (!memoryCache) throw error;
    return {
      ...memoryCache.data,
      stale: true,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}
