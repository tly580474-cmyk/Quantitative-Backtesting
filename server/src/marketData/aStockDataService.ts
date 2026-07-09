import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TENCENT_QUOTE_URL = 'https://qt.gtimg.cn/q=';
const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const TENCENT_MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
const TENCENT_SEARCH_URL = 'https://smartbox.gtimg.cn/s3/';
const EASTMONEY_REPORT_URL = 'https://reportapi.eastmoney.com/report/list';
const EASTMONEY_INFO_URL = 'https://push2.eastmoney.com/api/qt/stock/get';
const EASTMONEY_KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
};

export interface StockSearchItem {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  type: 'stock' | 'index' | 'etf';
}

export interface StockQuote extends StockSearchItem {
  price: number | null;
  changeAmount: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  limitUp: number | null;
  limitDown: number | null;
  turnoverPct: number | null;
  amplitudePct: number | null;
  volumeRatio: number | null;
  amountWan: number | null;
  peTtm: number | null;
  peStatic: number | null;
  pb: number | null;
  marketCapYi: number | null;
  floatMarketCapYi: number | null;
  listDate: string | null;
  industry: string | null;
  updatedAt: string;
  source: string[];
}

interface IndexDefinition {
  code: string;
  prefixed: string;
  name: string;
  market: 'SH' | 'SZ';
}

export interface KlinePoint {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  /** Daily turnover rate in percentage points; 0.41 means 0.41%. */
  turnoverRatePct?: number;
}

export type StockKlinePeriod = 'intraday' | 'day' | 'week' | 'year';

export interface ResearchReport {
  title: string;
  publishDate: string;
  organization: string;
  rating: string;
  industry: string;
  pdfUrl: string | null;
  infoCode: string;
}

export interface MarketSentimentFactor {
  key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  label: string;
  value: number;
  weight: number;
  source: 'live' | 'estimated' | 'neutral';
  formula: string;
  description: string;
}

export type MarketBreadthBucketKey =
  | 'upLimit' | 'up5' | 'up1' | 'up0' | 'flat'
  | 'down0' | 'down1' | 'down5' | 'downLimit';

export interface MarketBreadthStock {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  price: number | null;
  changePct: number;
  amountYi: number | null;
  turnoverPct: number | null;
  amplitudePct: number | null;
  volumeRatio: number | null;
}

export interface MarketBreadthBucket {
  key: MarketBreadthBucketKey;
  label: string;
  count: number;
  tone: 'up' | 'flat' | 'down';
  items: MarketBreadthStock[];
}

export interface MarketSentimentOverview {
  modelVersion: 2;
  updatedAt: string;
  total: number;
  advancers: number;
  decliners: number;
  flat: number;
  upLimit: number;
  downLimit: number;
  mainNetInYi: number;
  totalAmountYi: number;
  volumeBaselineYi: number | null;
  northboundNetYi: number | null;
  hs300AmplitudePct: number | null;
  hs300Amplitude20dPct: number | null;
  breakRate: number | null;
  ma5AbovePct: number | null;
  distribution: MarketBreadthBucket[];
  mainNetInTrend: Array<{ time: string; value: number }>;
  factors: MarketSentimentFactor[];
  msi: number;
  breadthIndexDivergence: number;
  structure: 'broad-rally' | 'broad-decline' | 'small-cap-led' | 'large-cap-led' | 'balanced';
  structureLabel: string;
  structureDescription: string;
  status: 'euphoria' | 'bullish' | 'neutral' | 'bearish' | 'panic';
  statusLabel: string;
  notes: string[];
}

export interface MarketTechnicalRow {
  code: string;
  name: string;
  market: 'SH' | 'SZ' | 'BJ';
  price: number | null;
  changePct: number | null;
  amountYi: number | null;
  turnoverPct: number | null;
  amplitudePct: number | null;
  volumeRatio: number | null;
}

let marketSentimentCache: { data: MarketSentimentOverview; cachedAt: number } | null = null;
let marketSentimentInFlight: Promise<MarketSentimentOverview> | null = null;
let marketTechnicalRowsCache: { data: MarketTechnicalRow[]; cachedAt: number } | null = null;
let marketTechnicalRowsInFlight: Promise<MarketTechnicalRow[]> | null = null;
let marketSentimentRefreshTimer: NodeJS.Timeout | null = null;
const MARKET_SENTIMENT_CACHE_MS = 5 * 60_000;
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
const AKSHARE_MARKET_SNAPSHOT_SCRIPT = localModulePath('./akshareMarketSnapshot.py', 'src/marketData/akshareMarketSnapshot.py');
const AKSHARE_TURNOVER_SCRIPT = localModulePath('./akshareTurnoverRate.py', 'src/marketData/akshareTurnoverRate.py');
const SINA_TURNOVER_CACHE_FILE = localModulePath('../../.cache/sina-turnover.json', '.cache/sina-turnover.json');
const SINA_TURNOVER_CACHE_MS = 24 * 60 * 60 * 1000; // 1 天
const SINA_TURNOVER_CACHE_VERSION = 2;
const MARKET_SENTIMENT_CACHE_FILE = localModulePath('../../.cache/market-sentiment.json', '.cache/market-sentiment.json');
const MARKET_SENTIMENT_UNIVERSE_FILE = localModulePath('../../.cache/market-universe.json', '.cache/market-universe.json');
const MARKET_TECHNICAL_CACHE_FILE = localModulePath('../../.cache/market-technical-rows.json', '.cache/market-technical-rows.json');
const UTC_MINUS_8_OFFSET_MS = 8 * 60 * 60 * 1000;
const MARKET_SENTIMENT_REFRESH_START_MINUTE = 9 * 60 + 15;
const MARKET_SENTIMENT_REFRESH_END_MINUTE = 15 * 60 + 30;

interface MarketUniverseItem {
  code: string;
  name: string;
}

const MARKET_INDEXES: IndexDefinition[] = [
  { code: '000001', prefixed: 'sh000001', name: '上证指数', market: 'SH' },
  { code: '399001', prefixed: 'sz399001', name: '深证成指', market: 'SZ' },
  { code: '399006', prefixed: 'sz399006', name: '创业板指', market: 'SZ' },
  { code: '000688', prefixed: 'sh000688', name: '科创50', market: 'SH' },
  { code: '000300', prefixed: 'sh000300', name: '沪深300', market: 'SH' },
  { code: '000905', prefixed: 'sh000905', name: '中证500', market: 'SH' },
  { code: '000852', prefixed: 'sh000852', name: '中证1000', market: 'SH' },
];

let eastmoneyQueue: Promise<void> = Promise.resolve();
let eastmoneyLastCall = 0;

function numberOrNull(value: unknown): number | null {
  if (value === '' || value === '-' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min = -100, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function decodeEscapedUnicode(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)));
}

function normalizeCode(input: string): string {
  const match = input.trim().toLowerCase().match(/(?:sh|sz|bj)?(\d{6})(?:\.(?:sh|sz|bj))?/);
  if (!match) throw new Error('请输入有效的 6 位 A 股代码');
  return match[1];
}

function resolveSecurity(input: string): { code: string; market: 'SH' | 'SZ' | 'BJ'; prefixed: string } {
  const value = input.trim().toLowerCase();
  const prefixMatch = value.match(/^(sh|sz|bj)(\d{6})$/);
  const suffixMatch = value.match(/^(\d{6})\.(sh|sz|bj)$/);
  if (prefixMatch) {
    const market = prefixMatch[1].toUpperCase() as 'SH' | 'SZ' | 'BJ';
    return { code: prefixMatch[2], market, prefixed: `${prefixMatch[1]}${prefixMatch[2]}` };
  }
  if (suffixMatch) {
    const market = suffixMatch[2].toUpperCase() as 'SH' | 'SZ' | 'BJ';
    return { code: suffixMatch[1], market, prefixed: `${suffixMatch[2]}${suffixMatch[1]}` };
  }
  const code = normalizeCode(input);
  const market = marketOf(code);
  return { code, market, prefixed: prefixOf(code) };
}

function marketOf(code: string): 'SH' | 'SZ' | 'BJ' {
  if (/^[689]/.test(code)) return 'SH';
  if (/^[48]/.test(code)) return 'BJ';
  return 'SZ';
}

function prefixOf(code: string): string {
  const market = marketOf(code);
  return market === 'SH' ? `sh${code}` : market === 'BJ' ? `bj${code}` : `sz${code}`;
}

function inferType(code: string, market = marketOf(code)): 'stock' | 'index' | 'etf' {
  if ((market === 'SH' && code.startsWith('000')) || (market === 'SZ' && code.startsWith('399'))) return 'index';
  if (/^(1[568]|5[168])/.test(code)) return 'etf';
  return 'stock';
}

async function fetchText(url: string, encoding = 'utf-8'): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`上游接口 HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    return new TextDecoder(encoding).decode(bytes);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`上游接口 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error('上游接口暂时不可用');
}

async function eastmoneyGet(url: string, params: URLSearchParams, referer: string): Promise<Response> {
  const run = eastmoneyQueue.then(async () => {
    const wait = Math.max(0, 1200 - (Date.now() - eastmoneyLastCall));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait + Math.floor(Math.random() * 250)));
    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const response = await fetch(`${url}?${params.toString()}`, {
            headers: { ...BROWSER_HEADERS, Referer: referer },
            signal: AbortSignal.timeout(20000),
          });
          if (response.ok) return response;
          lastError = new Error(`东方财富接口 HTTP ${response.status}`);
        } catch (error) {
          lastError = error;
        }
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt + Math.floor(Math.random() * 200)));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('东方财富接口暂时不可用');
    } finally {
      eastmoneyLastCall = Date.now();
    }
  });
  eastmoneyQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function searchStocks(keyword: string, limit = 12): Promise<StockSearchItem[]> {
  const query = keyword.trim();
  if (!query) return [];
  const params = new URLSearchParams({ q: query, t: 'all', c: '1' });
  const text = await fetchText(`${TENCENT_SEARCH_URL}?${params.toString()}`, 'gbk');
  const payload = text.match(/v_hint="([\s\S]*?)"/)?.[1] ?? text.match(/"([\s\S]*?)"/)?.[1] ?? '';
  const seen = new Set<string>();
  const items: StockSearchItem[] = [];
  for (const row of payload.split('^')) {
    const fields = row.split('~');
    if (fields.length < 3) continue;
    const rawMarket = fields[0]?.toLowerCase();
    const code = fields[1];
    const name = decodeEscapedUnicode(fields[2]);
    if (!/^\d{6}$/.test(code) || !name || seen.has(code)) continue;
    const market = rawMarket === 'sh' ? 'SH' : rawMarket === 'bj' ? 'BJ' : 'SZ';
    const type = inferType(code, market);
    if (type !== 'stock') continue;
    seen.add(code);
    items.push({ code, name, market, type });
    if (items.length >= limit) break;
  }

  // 腾讯联想偶尔对纯代码不返回结果；直接验证代码可保证全市场可选。
  if (items.length === 0 && /^\d{6}$/.test(query)) {
    const quote = await fetchStockQuote(query, false);
    if (quote.name) items.push({ code: quote.code, name: quote.name, market: quote.market, type: quote.type });
  }
  return items;
}

export async function fetchStockQuote(input: string, withProfile = true): Promise<StockQuote> {
  const { code, market, prefixed } = resolveSecurity(input);
  const text = await fetchText(`${TENCENT_QUOTE_URL}${prefixed}`, 'gbk');
  const values = text.match(/"([\s\S]*?)"/)?.[1]?.split('~') ?? [];
  if (values.length < 53 || !values[1]) throw new Error(`未找到证券 ${code}`);

  let profile: { industry: string | null; listDate: string | null } = { industry: null, listDate: null };
  if (withProfile && inferType(code, market) === 'stock') {
    try {
      const marketCode = market === 'SH' ? '1' : '0';
      const params = new URLSearchParams({ fltt: '2', invt: '2', fields: 'f127,f189', secid: `${marketCode}.${code}` });
      const response = await eastmoneyGet(EASTMONEY_INFO_URL, params, 'https://quote.eastmoney.com/');
      const data = (await response.json() as { data?: Record<string, unknown> }).data ?? {};
      const rawDate = String(data.f189 ?? '');
      profile = {
        industry: String(data.f127 ?? '') || null,
        listDate: /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}` : null,
      };
    } catch {
      // 实时行情可独立展示，东财资料失败不应拖垮整张详情页。
    }
  }

  return parseTencentQuote(values, {
    code,
    market,
    type: inferType(code, market),
    ...profile,
    source: profile.industry || profile.listDate ? ['腾讯财经', '东方财富'] : ['腾讯财经'],
  });
}

export async function fetchMarketIndexQuotes(): Promise<StockQuote[]> {
  const text = await fetchText(`${TENCENT_QUOTE_URL}${MARKET_INDEXES.map((item) => item.prefixed).join(',')}`, 'gbk');
  return MARKET_INDEXES.flatMap((item) => {
    const pattern = new RegExp(`v_${item.prefixed}="([\\s\\S]*?)";`);
    const values = text.match(pattern)?.[1]?.split('~') ?? [];
    if (values.length < 53 || !values[1]) return [];
    return [parseTencentQuote(values, {
      code: item.code,
      name: item.name,
      market: item.market,
      type: 'index',
      industry: '大盘指数',
      listDate: null,
      source: ['腾讯财经'],
    })];
  });
}

function sentimentStatus(msi: number): Pick<MarketSentimentOverview, 'status' | 'statusLabel'> {
  if (msi > 60) return { status: 'euphoria', statusLabel: '极致狂热' };
  if (msi > 30) return { status: 'bullish', statusLabel: '乐观多头' };
  if (msi >= -30) return { status: 'neutral', statusLabel: '中性震荡' };
  if (msi >= -60) return { status: 'bearish', statusLabel: '悲观空头' };
  return { status: 'panic', statusLabel: '极致恐慌' };
}

function buildFactor(
  key: MarketSentimentFactor['key'],
  label: string,
  value: number,
  weight: number,
  source: MarketSentimentFactor['source'],
  formula: string,
  description: string,
): MarketSentimentFactor {
  return { key, label, value: round(clamp(value)), weight, source, formula, description };
}

async function fetchAkshareAStockRows(): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [AKSHARE_MARKET_SNAPSHOT_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('AKShare 数据源超时'));
    }, 150000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        try {
          const payload = JSON.parse(stderr.trim()) as { error?: string };
          reject(new Error(payload.error || `AKShare 进程退出：${code}`));
        } catch {
          reject(new Error(`AKShare 进程退出：${code}`));
        }
        return;
      }
      try {
        const payload = JSON.parse(stdout) as { items?: Array<Record<string, unknown>> };
        resolve(payload.items ?? []);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('AKShare 输出解析失败'));
      }
    });
  });
}

interface SinaTurnoverCacheEntry {
  version?: number;
  cachedAt: number;
  items: Array<{ date: string; turnoverRatePct: number | null }>;
}

async function loadSinaTurnoverDiskCache(): Promise<Record<string, SinaTurnoverCacheEntry> | null> {
  try {
    const text = await readFile(SINA_TURNOVER_CACHE_FILE, 'utf8');
    return JSON.parse(text) as Record<string, SinaTurnoverCacheEntry>;
  } catch {
    return null;
  }
}

async function persistSinaTurnoverDiskCache(map: Record<string, SinaTurnoverCacheEntry>): Promise<void> {
  try {
    await mkdir(resolve(SINA_TURNOVER_CACHE_FILE, '..'), { recursive: true });
    await writeFile(SINA_TURNOVER_CACHE_FILE, JSON.stringify(map), 'utf8');
  } catch {
    // 写盘失败不影响主流程，下次请求会重新拉取。
  }
}

export function normalizeSinaTurnoverRatePct(value: unknown): number | null {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  // Akshare's Sina daily `turnover` field is a ratio (0.09 means 9%).
  // The app stores turnoverRatePct in percentage points (9 means 9%).
  return parsed * 100;
}

/**
 * 通过新浪（akshare）历史日频接口补全个股历史每日换手率。
 * 仅在东财 K 线降级时使用，按代码缓存最近 5 年序列，避免每次悬停都触发 Python 子进程。
 * 若 akshare 未安装或接口不可用，抛出错误由调用方静默吞掉，退回到腾讯行情快照兜底。
 */
async function fetchSinaTurnoverSeries(
  security: { code: string; market: 'SH' | 'SZ' | 'BJ'; prefixed: string },
): Promise<Map<string, number>> {
  const cacheKey = security.code;
  const now = Date.now();

  // 第一级：磁盘缓存（1 天内直接复用）
  const disk = await loadSinaTurnoverDiskCache();
  const cached = disk?.[cacheKey];
  if (cached?.version === SINA_TURNOVER_CACHE_VERSION && now - cached.cachedAt < SINA_TURNOVER_CACHE_MS) {
    const map = new Map<string, number>();
    for (const it of cached.items) if (it.turnoverRatePct != null) map.set(it.date, it.turnoverRatePct);
    return map;
  }

  // 近 5 年窗口，覆盖绝大多数 K 线视图；缓存后由调用方按日期切片。
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 5);
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

  const result = await new Promise<Map<string, number>>((resolve, reject) => {
    const child = spawn('python', [AKSHARE_TURNOVER_SCRIPT, security.prefixed, fmt(start), fmt(end)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Akshare 换手率数据源超时'));
    }, 120000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        try {
          const payload = JSON.parse(stderr.trim()) as { error?: string };
          reject(new Error(payload.error || `Akshare 进程退出：${code}`));
        } catch {
          reject(new Error(`Akshare 进程退出：${code}`));
        }
        return;
      }
      try {
        const payload = JSON.parse(stdout) as { items?: Array<{ date: string; turnover_rate: number | null }> };
        const map = new Map<string, number>();
        for (const it of payload.items ?? []) {
          const turnoverRatePct = normalizeSinaTurnoverRatePct(it.turnover_rate);
          if (turnoverRatePct != null) map.set(it.date, turnoverRatePct);
        }
        resolve(map);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Akshare 输出解析失败'));
      }
    });
  });

  // 落盘缓存（合并已有条目，避免并发覆盖）
  const merged = (await loadSinaTurnoverDiskCache()) ?? {};
  merged[cacheKey] = {
    version: SINA_TURNOVER_CACHE_VERSION,
    cachedAt: now,
    items: Array.from(result.entries()).map(([date, turnoverRatePct]) => ({ date, turnoverRatePct })),
  };
  await persistSinaTurnoverDiskCache(merged);

  return result;
}

function rowToUniverseItem(row: Record<string, unknown>): MarketUniverseItem | null {
  const code = String(row.f12 ?? '').trim();
  const name = String(row.f14 ?? '').trim();
  return /^\d{6}$/.test(code) && name ? { code, name } : null;
}

async function readMarketUniverse(): Promise<MarketUniverseItem[]> {
  try {
    const text = await readFile(MARKET_SENTIMENT_UNIVERSE_FILE, 'utf8');
    const parsed = JSON.parse(text) as { items?: MarketUniverseItem[] };
    return (parsed.items ?? []).filter((item) => /^\d{6}$/.test(item.code) && item.name);
  } catch {
    return [];
  }
}

async function writeMarketUniverse(items: MarketUniverseItem[]): Promise<void> {
  await mkdir(resolve(MARKET_SENTIMENT_UNIVERSE_FILE, '..'), { recursive: true });
  await writeFile(MARKET_SENTIMENT_UNIVERSE_FILE, JSON.stringify({ items, updatedAt: new Date().toISOString() }), 'utf8');
}

function tencentMarketPrefix(code: string): string {
  if (/^[489]/.test(code)) return `bj${code}`;
  if (/^[68]/.test(code)) return `sh${code}`;
  return `sz${code}`;
}

function parseTencentSentimentRows(text: string, universeByCode: Map<string, MarketUniverseItem>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const matches = text.matchAll(/v_(?:sh|sz|bj)(\d{6})="([\s\S]*?)";/g);
  for (const match of matches) {
    const code = match[1];
    const values = match[2].split('~');
    const name = values[1] || universeByCode.get(code)?.name || '';
    if (!name) continue;
    rows.push({
      f12: code,
      f14: name,
      f2: numberOrNull(values[3]),
      f3: numberOrNull(values[32]),
      f6: (numberOrNull(values[37]) ?? 0) * 10000,
      f8: numberOrNull(values[38]),
      f10: numberOrNull(values[49]),
      f7: numberOrNull(values[43]),
      f62: 0,
      f47: numberOrNull(values[47]),
      f48: numberOrNull(values[48]),
    });
  }
  return rows;
}

async function fetchTencentAStockRows(universe: MarketUniverseItem[]): Promise<Array<Record<string, unknown>>> {
  const universeByCode = new Map(universe.map((item) => [item.code, item]));
  const prefixed = universe.map((item) => tencentMarketPrefix(item.code));
  const chunkSize = 70;
  const chunks: string[][] = [];
  for (let index = 0; index < prefixed.length; index += chunkSize) chunks.push(prefixed.slice(index, index + chunkSize));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, chunks.length) }, async () => {
    const workerRows: Array<Record<string, unknown>> = [];
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const text = await fetchText(`${TENCENT_QUOTE_URL}${chunk.join(',')}`, 'gbk');
      workerRows.push(...parseTencentSentimentRows(text, universeByCode));
    }
    return workerRows;
  });
  return (await Promise.all(workers)).flat();
}

async function fetchAStockSentimentRows(): Promise<Array<Record<string, unknown>>> {
  const universe = await readMarketUniverse();
  if (universe.length > 500) {
    try {
      const rows = await fetchTencentAStockRows(universe);
      if (rows.length > 500) return rows;
    } catch {
      // Fall through to AKShare bootstrap when the cached universe cannot be quoted.
    }
  }
  const rows = await fetchAkshareAStockRows();
  const nextUniverse = rows.map(rowToUniverseItem).filter((item): item is MarketUniverseItem => item != null);
  if (nextUniverse.length > 500) await writeMarketUniverse(nextUniverse).catch(() => undefined);
  return rows;
}

function marketForCode(code: string): MarketTechnicalRow['market'] {
  if (/^(?:4|8|92)/.test(code)) return 'BJ';
  if (/^[68]/.test(code)) return 'SH';
  return 'SZ';
}

function toMarketTechnicalRows(rows: Array<Record<string, unknown>>): MarketTechnicalRow[] {
  return rows.flatMap((row) => {
    const code = String(row.f12 ?? '').trim();
    const name = String(row.f14 ?? '').trim();
    if (!/^\d{6}$/.test(code) || !name) return [];
    const amount = numberOrNull(row.f6);
    return [{
      code,
      name,
      market: marketForCode(code),
      price: numberOrNull(row.f2),
      changePct: numberOrNull(row.f3),
      amountYi: amount == null ? null : round(amount / 100_000_000),
      turnoverPct: numberOrNull(row.f8),
      amplitudePct: numberOrNull(row.f7),
      volumeRatio: numberOrNull(row.f10),
    }];
  });
}

export async function fetchMarketTechnicalRows(force = false): Promise<MarketTechnicalRow[]> {
  if (!force && marketTechnicalRowsCache && Date.now() - marketTechnicalRowsCache.cachedAt < MARKET_SENTIMENT_CACHE_MS) {
    return marketTechnicalRowsCache.data;
  }
  if (!force && !marketTechnicalRowsCache) {
    try {
      const parsed = JSON.parse(await readFile(MARKET_TECHNICAL_CACHE_FILE, 'utf8')) as {
        data?: MarketTechnicalRow[];
        cachedAt?: number;
      };
      if (Array.isArray(parsed.data) && parsed.data.length > 500 && Number.isFinite(parsed.cachedAt)) {
        marketTechnicalRowsCache = { data: parsed.data, cachedAt: Number(parsed.cachedAt) };
      }
    } catch {
      // The first run has no disk snapshot yet.
    }
  }
  if (!force && marketTechnicalRowsCache) {
    if (Date.now() - marketTechnicalRowsCache.cachedAt >= MARKET_SENTIMENT_CACHE_MS && !marketTechnicalRowsInFlight) {
      void refreshMarketTechnicalRows().catch(() => undefined);
    }
    return marketTechnicalRowsCache.data;
  }
  return refreshMarketTechnicalRows();
}

async function refreshMarketTechnicalRows(): Promise<MarketTechnicalRow[]> {
  if (marketTechnicalRowsInFlight) return marketTechnicalRowsInFlight;
  marketTechnicalRowsInFlight = (async () => {
    const data = toMarketTechnicalRows(await fetchAStockSentimentRows());
    const cachedAt = Date.now();
    marketTechnicalRowsCache = { data, cachedAt };
    await mkdir(resolve(MARKET_TECHNICAL_CACHE_FILE, '..'), { recursive: true });
    await writeFile(MARKET_TECHNICAL_CACHE_FILE, JSON.stringify({ data, cachedAt }), 'utf8').catch(() => undefined);
    return data;
  })().finally(() => {
    marketTechnicalRowsInFlight = null;
  });
  return marketTechnicalRowsInFlight;
}

function buildMainNetInTrend(mainNetInYi: number): MarketSentimentOverview['mainNetInTrend'] {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const labels = currentMinutes < 13 * 60
    ? ['09:30', '10:00', '10:30', '11:00', '11:30']
    : ['09:30', '10:30', '11:30', '13:30', '14:30', '15:00'];
  return labels.map((time, index) => {
    const progress = labels.length <= 1 ? 1 : index / (labels.length - 1);
    const curve = 0.18 + progress * 0.82;
    return { time, value: round(mainNetInYi * curve) };
  });
}

const MARKET_BREADTH_BUCKETS: Array<Omit<MarketBreadthBucket, 'count' | 'items'>> = [
  { key: 'upLimit', label: '涨停', tone: 'up' },
  { key: 'up5', label: '5%至涨停', tone: 'up' },
  { key: 'up1', label: '1%至5%', tone: 'up' },
  { key: 'up0', label: '0%至1%', tone: 'up' },
  { key: 'flat', label: '平盘', tone: 'flat' },
  { key: 'down0', label: '0%至-1%', tone: 'down' },
  { key: 'down1', label: '-1%至-5%', tone: 'down' },
  { key: 'down5', label: '-5%至跌停', tone: 'down' },
  { key: 'downLimit', label: '跌停', tone: 'down' },
];

function fallbackLimitPct(code: string): number {
  if (/^(?:4|8|92)/.test(code)) return 30;
  if (/^(?:300|301|688|689)/.test(code)) return 20;
  return 10;
}

function priceLimitState(
  row: Record<string, unknown>,
  code: string,
  changePct: number,
): 'up' | 'down' | null {
  const price = numberOrNull(row.f2);
  const limitUp = numberOrNull(row.f47);
  const limitDown = numberOrNull(row.f48);
  const hasExactLimitFields = Object.hasOwn(row, 'f47') || Object.hasOwn(row, 'f48');
  if (hasExactLimitFields) {
    if (price != null && limitUp != null && limitUp > 0 && price >= limitUp - 0.005) return 'up';
    if (price != null && limitDown != null && limitDown > 0 && price <= limitDown + 0.005) return 'down';
    return null;
  }
  const threshold = fallbackLimitPct(code) - 0.2;
  if (changePct >= threshold) return 'up';
  if (changePct <= -threshold) return 'down';
  return null;
}

export function buildMarketBreadthSnapshot(rows: Array<Record<string, unknown>>): {
  total: number;
  advancers: number;
  decliners: number;
  flat: number;
  upLimit: number;
  downLimit: number;
  totalAmountYuan: number;
  mainNetInYuan: number;
  distribution: MarketBreadthBucket[];
} {
  const bucketItems = new Map<MarketBreadthBucketKey, MarketBreadthStock[]>(
    MARKET_BREADTH_BUCKETS.map((bucket) => [bucket.key, []]),
  );
  const seen = new Set<string>();
  let totalAmountYuan = 0;
  let mainNetInYuan = 0;

  for (const row of rows) {
    const code = String(row.f12 ?? '').trim();
    const name = String(row.f14 ?? '').trim();
    const changePct = numberOrNull(row.f3);
    if (!/^\d{6}$/.test(code) || !name || /ST|退/i.test(name) || changePct == null || seen.has(code)) continue;
    seen.add(code);
    const amountYuan = numberOrNull(row.f6);
    totalAmountYuan += amountYuan ?? 0;
    mainNetInYuan += numberOrNull(row.f62) ?? 0;

    const stock: MarketBreadthStock = {
      code,
      name,
      market: marketForCode(code),
      price: numberOrNull(row.f2),
      changePct,
      amountYi: amountYuan == null ? null : round(amountYuan / 100_000_000),
      turnoverPct: numberOrNull(row.f8),
      amplitudePct: numberOrNull(row.f7),
      volumeRatio: numberOrNull(row.f10),
    };
    const limitState = priceLimitState(row, code, changePct);
    let bucket: MarketBreadthBucketKey;
    if (limitState === 'up') bucket = 'upLimit';
    else if (limitState === 'down') bucket = 'downLimit';
    else if (changePct >= 5) bucket = 'up5';
    else if (changePct >= 1) bucket = 'up1';
    else if (changePct > 0) bucket = 'up0';
    else if (changePct === 0) bucket = 'flat';
    else if (changePct > -1) bucket = 'down0';
    else if (changePct > -5) bucket = 'down1';
    else bucket = 'down5';
    bucketItems.get(bucket)!.push(stock);
  }

  const distribution = MARKET_BREADTH_BUCKETS.map((bucket) => {
    const items = bucketItems.get(bucket.key)!;
    items.sort((a, b) => bucket.tone === 'up'
      ? b.changePct - a.changePct
      : bucket.tone === 'down'
        ? a.changePct - b.changePct
        : (b.amountYi ?? 0) - (a.amountYi ?? 0));
    return { ...bucket, count: items.length, items };
  });
  const count = (keys: MarketBreadthBucketKey[]) => distribution
    .filter((bucket) => keys.includes(bucket.key))
    .reduce((sum, bucket) => sum + bucket.count, 0);

  return {
    total: distribution.reduce((sum, bucket) => sum + bucket.count, 0),
    advancers: count(['upLimit', 'up5', 'up1', 'up0']),
    decliners: count(['down0', 'down1', 'down5', 'downLimit']),
    flat: count(['flat']),
    upLimit: count(['upLimit']),
    downLimit: count(['downLimit']),
    totalAmountYuan,
    mainNetInYuan,
    distribution,
  };
}

interface MarketSentimentCalculation {
  factors: MarketSentimentFactor[];
  msi: number;
  breadthIndexDivergence: number;
  structure: MarketSentimentOverview['structure'];
  structureLabel: string;
  structureDescription: string;
}

export function calculateMarketSentiment(
  breadth: Pick<
    ReturnType<typeof buildMarketBreadthSnapshot>,
    'total' | 'advancers' | 'decliners' | 'upLimit' | 'downLimit' | 'distribution'
  >,
  indexQuotes: Array<Pick<StockQuote, 'code' | 'changePct'>>,
): MarketSentimentCalculation {
  const directionalCount = breadth.advancers + breadth.decliners;
  const breadthScore = directionalCount > 0
    ? ((breadth.advancers - breadth.decliners) / directionalCount) * 100
    : 0;

  const stocks = breadth.distribution.flatMap((bucket) => bucket.items);
  let strengthNumerator = 0;
  let strengthDenominator = 0;
  for (const stock of stocks) {
    const amountWeight = Math.sqrt(Math.max(stock.amountYi ?? 0, 0)) || 1;
    strengthNumerator += amountWeight * clamp(stock.changePct, -7, 7);
    strengthDenominator += amountWeight * 7;
  }
  const strengthScore = strengthDenominator > 0
    ? clamp((strengthNumerator / strengthDenominator) * 100)
    : 0;

  const indexWeights: Record<string, number> = {
    '000300': 0.50,
    '399001': 0.20,
    '000905': 0.15,
    '000852': 0.10,
    '000688': 0.05,
  };
  let indexReturn = 0;
  let availableIndexWeight = 0;
  for (const quote of indexQuotes) {
    const weight = indexWeights[quote.code];
    if (!weight || quote.changePct == null || !Number.isFinite(quote.changePct)) continue;
    indexReturn += quote.changePct * weight;
    availableIndexWeight += weight;
  }
  const hasIndexFactor = availableIndexWeight > 0;
  const normalizedIndexReturn = hasIndexFactor ? indexReturn / availableIndexWeight : 0;
  const indexScore = hasIndexFactor ? clamp(100 * Math.tanh(normalizedIndexReturn / 1.5)) : 0;
  const extremeScore = breadth.total > 0
    ? clamp(2000 * (breadth.upLimit - breadth.downLimit) / breadth.total)
    : 0;

  const definitions = [
    {
      key: 'A' as const,
      label: '市场广度',
      value: breadthScore,
      baseWeight: 0.25,
      source: directionalCount > 0 ? 'live' as const : 'neutral' as const,
      active: directionalCount > 0,
      formula: '(上涨家数-下跌家数)/(上涨家数+下跌家数)×100',
      description: '等权衡量多数股票的方向，不单独代表权重指数',
    },
    {
      key: 'B' as const,
      label: '涨跌强度',
      value: strengthScore,
      baseWeight: 0.20,
      source: stocks.length > 0 ? 'live' as const : 'neutral' as const,
      active: stocks.length > 0,
      formula: 'Σ(√成交额×截断涨跌幅)/Σ(√成交额×7%)×100',
      description: '兼顾涨跌幅和流动性，并降低少数巨量股票的支配程度',
    },
    {
      key: 'C' as const,
      label: '权重指数',
      value: indexScore,
      baseWeight: 0.40,
      source: hasIndexFactor ? 'live' as const : 'neutral' as const,
      active: hasIndexFactor,
      formula: '100×tanh(宽基指数加权涨跌幅/1.5%)',
      description: '沪深300占50%，并综合深证成指、中证500/1000与科创50',
    },
    {
      key: 'D' as const,
      label: '极端情绪',
      value: extremeScore,
      baseWeight: 0.15,
      source: breadth.total > 0 ? 'estimated' as const : 'neutral' as const,
      active: breadth.total > 0,
      formula: '2000×(涨停家数-跌停家数)/有效股票数',
      description: '按全市场样本归一化，避免少量涨跌停把温度计推至极端',
    },
  ];
  const activeWeight = definitions
    .filter((factor) => factor.active)
    .reduce((sum, factor) => sum + factor.baseWeight, 0);
  const factors = definitions.map((factor) => buildFactor(
    factor.key,
    factor.label,
    clamp(factor.value),
    factor.active && activeWeight > 0 ? factor.baseWeight / activeWeight : 0,
    factor.source,
    factor.formula,
    factor.description,
  ));
  const msi = round(clamp(factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0)));
  const breadthIndexDivergence = round(breadthScore - indexScore);

  if (breadthScore > 15 && indexScore < -15 && breadthIndexDivergence > 35) {
    return {
      factors,
      msi,
      breadthIndexDivergence,
      structure: 'small-cap-led',
      structureLabel: '结构性分化',
      structureDescription: '多数个股上涨，但权重指数承压；小盘与题材相对活跃。',
    };
  }
  if (breadthScore < -15 && indexScore > 15 && breadthIndexDivergence < -35) {
    return {
      factors,
      msi,
      breadthIndexDivergence,
      structure: 'large-cap-led',
      structureLabel: '权重股主导',
      structureDescription: '权重指数走强，但多数个股下跌；赚钱效应集中于大盘股。',
    };
  }
  if (breadthScore > 15 && indexScore > 15) {
    return {
      factors,
      msi,
      breadthIndexDivergence,
      structure: 'broad-rally',
      structureLabel: '普涨共振',
      structureDescription: '多数个股与权重指数同步走强，市场风险偏好较一致。',
    };
  }
  if (breadthScore < -15 && indexScore < -15) {
    return {
      factors,
      msi,
      breadthIndexDivergence,
      structure: 'broad-decline',
      structureLabel: '普跌共振',
      structureDescription: '多数个股与权重指数同步走弱，市场风险偏好明显下降。',
    };
  }
  return {
    factors,
    msi,
    breadthIndexDivergence,
    structure: 'balanced',
    structureLabel: '震荡均衡',
    structureDescription: '市场广度与权重指数未形成显著同向或背离结构。',
  };
}

export async function fetchMarketSentimentOverview(): Promise<MarketSentimentOverview> {
  const [rowsResult, hs300KlineResult, indexQuotesResult] = await Promise.allSettled([
    fetchAStockSentimentRows(),
    fetchStockKline('sh000300', 'day', 28).catch(() => []),
    fetchMarketIndexQuotes(),
  ]);
  const rows = rowsResult.status === 'fulfilled' ? rowsResult.value : [];
  const hs300Kline = hs300KlineResult.status === 'fulfilled' ? hs300KlineResult.value : [];
  const indexQuotes = indexQuotesResult.status === 'fulfilled' ? indexQuotesResult.value : [];
  const dataNotes: string[] = [];
  if (rowsResult.status === 'rejected') {
    const reason = rowsResult.reason instanceof Error ? rowsResult.reason.message : '未知错误';
    dataNotes.push(`AKShare 全市场涨跌分布暂不可用：${reason}`);
  }
  if (hs300KlineResult.status === 'rejected') {
    dataNotes.push('沪深300波动数据暂不可用。');
  }
  if (indexQuotesResult.status === 'rejected') {
    dataNotes.push('宽基指数实时涨跌暂不可用，综合情绪已按可用因子重新归一化。');
  }
  const breadth = buildMarketBreadthSnapshot(rows);
  const {
    advancers, decliners, flat, upLimit, downLimit,
    mainNetInYuan, totalAmountYuan,
  } = breadth;

  const latestHs300 = hs300Kline.at(-1);
  const previousHs300 = hs300Kline.at(-2);
  const amplitudeSeries = hs300Kline.slice(-21).map((point, index, all) => {
    const previous = index === 0 ? null : all[index - 1];
    const base = previous?.close || point.open;
    return base ? ((point.high - point.low) / base) * 100 : 0;
  }).filter(Number.isFinite);
  const hs300AmplitudePct = latestHs300 && previousHs300?.close
    ? ((latestHs300.high - latestHs300.low) / previousHs300.close) * 100
    : null;
  const hs300Amplitude20dPct = amplitudeSeries.length > 1
    ? amplitudeSeries.slice(0, -1).reduce((sum, value) => sum + value, 0) / (amplitudeSeries.length - 1)
    : null;

  const calculation = calculateMarketSentiment(breadth, indexQuotes);
  const status = sentimentStatus(calculation.msi);

  return {
    modelVersion: 2,
    updatedAt: new Date().toISOString(),
    total: breadth.total,
    advancers,
    decliners,
    flat,
    upLimit,
    downLimit,
    mainNetInYi: round(mainNetInYuan / 100000000),
    totalAmountYi: round(totalAmountYuan / 100000000),
    volumeBaselineYi: null,
    northboundNetYi: null,
    hs300AmplitudePct: hs300AmplitudePct == null ? null : round(hs300AmplitudePct),
    hs300Amplitude20dPct: hs300Amplitude20dPct == null ? null : round(hs300Amplitude20dPct),
    breakRate: null,
    ma5AbovePct: null,
    distribution: breadth.distribution,
    mainNetInTrend: buildMainNetInTrend(round(mainNetInYuan / 100000000)),
    ...calculation,
    ...status,
    notes: [
      ...dataNotes,
      '统计口径：A股有效报价，按证券代码去重并排除名称含 ST/退的股票；九个涨跌区间严格互斥，其合计等于有效样本数。',
      '涨跌停优先按腾讯行情返回的当日涨停价/跌停价判断；仅在 AKShare/Sina 首次初始化且缺少限价字段时，按主板10%、创业板/科创板20%、北交所30%的阈值估算。',
      'MSI v2 = 0.25 × 市场广度 + 0.20 × 涨跌强度 + 0.40 × 权重指数 + 0.15 × 极端情绪；数据缺失时按可用因子重新归一化。',
      '权重指数综合沪深300、深证成指、中证500、中证1000与科创50；涨跌强度使用成交额平方根加权。',
    ],
  };
}

function buildPendingMarketSentimentOverview(): MarketSentimentOverview {
  const factors: MarketSentimentFactor[] = [
    buildFactor('A', '市场广度', 0, 0.25, 'neutral', '(上涨家数-下跌家数)/(上涨家数+下跌家数)×100', '等待全市场快照刷新'),
    buildFactor('B', '涨跌强度', 0, 0.20, 'neutral', '成交额平方根加权涨跌幅', '等待全市场快照刷新'),
    buildFactor('C', '权重指数', 0, 0.40, 'neutral', '宽基指数加权涨跌幅', '等待宽基指数报价刷新'),
    buildFactor('D', '极端情绪', 0, 0.15, 'neutral', '(涨停家数-跌停家数)/有效股票数', '等待全市场快照刷新'),
  ];
  return {
    modelVersion: 2,
    updatedAt: new Date().toISOString(),
    total: 0,
    advancers: 0,
    decliners: 0,
    flat: 0,
    upLimit: 0,
    downLimit: 0,
    mainNetInYi: 0,
    totalAmountYi: 0,
    volumeBaselineYi: null,
    northboundNetYi: null,
    hs300AmplitudePct: null,
    hs300Amplitude20dPct: null,
    breakRate: null,
    ma5AbovePct: null,
    distribution: [
      ...MARKET_BREADTH_BUCKETS.map((bucket) => ({ ...bucket, count: 0, items: [] })),
    ],
    mainNetInTrend: buildMainNetInTrend(0),
    factors,
    msi: 0,
    breadthIndexDivergence: 0,
    structure: 'balanced',
    structureLabel: '数据更新中',
    structureDescription: '正在生成市场广度与权重指数联合快照。',
    status: 'neutral',
    statusLabel: '后台更新中',
    notes: [
      '市场概况正在后台刷新；首次生成全市场快照可能需要 1-3 分钟。',
      '之后会优先返回本地缓存，不再阻塞页面加载。',
    ],
  };
}

async function readMarketSentimentDiskCache(): Promise<{ data: MarketSentimentOverview; cachedAt: number } | null> {
  try {
    const text = await readFile(MARKET_SENTIMENT_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(text) as { data?: MarketSentimentOverview; cachedAt?: number };
    if (
      !parsed.data
      || parsed.data.modelVersion !== 2
      || typeof parsed.cachedAt !== 'number'
      || !Array.isArray(parsed.data.distribution)
      || !parsed.data.distribution.every((bucket) => Array.isArray(bucket.items))
    ) return null;
    return { data: parsed.data, cachedAt: parsed.cachedAt };
  } catch {
    return null;
  }
}

async function writeMarketSentimentDiskCache(data: MarketSentimentOverview, cachedAt: number): Promise<void> {
  await mkdir(resolve(MARKET_SENTIMENT_CACHE_FILE, '..'), { recursive: true });
  await writeFile(MARKET_SENTIMENT_CACHE_FILE, JSON.stringify({ data, cachedAt }), 'utf8');
}

function isMarketSentimentAutoRefreshWindow(now = new Date()): boolean {
  const utcMinus8 = new Date(now.getTime() - UTC_MINUS_8_OFFSET_MS);
  const minutes = utcMinus8.getUTCHours() * 60 + utcMinus8.getUTCMinutes();
  return minutes >= MARKET_SENTIMENT_REFRESH_START_MINUTE
    && minutes <= MARKET_SENTIMENT_REFRESH_END_MINUTE;
}

function refreshMarketSentiment(): Promise<MarketSentimentOverview> {
  if (marketSentimentInFlight) return marketSentimentInFlight;
  marketSentimentInFlight = fetchMarketSentimentOverview()
    .then(async (data) => {
      const cachedAt = Date.now();
      marketSentimentCache = { data, cachedAt };
      await writeMarketSentimentDiskCache(data, cachedAt).catch(() => undefined);
      ensureMarketSentimentRefreshLoop();
      return data;
    })
    .finally(() => {
      marketSentimentInFlight = null;
    });
  return marketSentimentInFlight;
}

function refreshMarketSentimentInBackground(): void {
  if (!isMarketSentimentAutoRefreshWindow()) return;
  void refreshMarketSentiment().catch(() => undefined);
}

function ensureMarketSentimentRefreshLoop(): void {
  if (marketSentimentRefreshTimer) return;
  marketSentimentRefreshTimer = setInterval(() => {
    refreshMarketSentimentInBackground();
  }, MARKET_SENTIMENT_CACHE_MS);
  marketSentimentRefreshTimer.unref?.();
}

export async function fetchCachedMarketSentimentOverview(force = false): Promise<MarketSentimentOverview> {
  if (!force && marketSentimentCache && Date.now() - marketSentimentCache.cachedAt < MARKET_SENTIMENT_CACHE_MS) {
    ensureMarketSentimentRefreshLoop();
    return marketSentimentCache.data;
  }
  if (force) {
    return refreshMarketSentiment();
  }
  if (!marketSentimentCache) {
    const diskCache = await readMarketSentimentDiskCache();
    if (diskCache) {
      marketSentimentCache = diskCache;
      ensureMarketSentimentRefreshLoop();
    }
  }
  if (marketSentimentCache) {
    ensureMarketSentimentRefreshLoop();
    if (Date.now() - marketSentimentCache.cachedAt >= MARKET_SENTIMENT_CACHE_MS) {
      refreshMarketSentimentInBackground();
    }
    return marketSentimentCache.data;
  }
  void refreshMarketSentiment().catch(() => undefined);
  return buildPendingMarketSentimentOverview();
}

function parseTencentQuote(
  values: string[],
  base: Pick<StockQuote, 'code' | 'market' | 'type' | 'industry' | 'listDate' | 'source'> & { name?: string },
): StockQuote {
  return {
    code: base.code,
    name: base.name ?? values[1],
    market: base.market,
    type: base.type,
    price: numberOrNull(values[3]),
    previousClose: numberOrNull(values[4]),
    open: numberOrNull(values[5]),
    changeAmount: numberOrNull(values[31]),
    changePct: numberOrNull(values[32]),
    high: numberOrNull(values[33]),
    low: numberOrNull(values[34]),
    amountWan: numberOrNull(values[37]),
    turnoverPct: numberOrNull(values[38]),
    peTtm: numberOrNull(values[39]),
    amplitudePct: numberOrNull(values[43]),
    floatMarketCapYi: numberOrNull(values[44]),
    marketCapYi: numberOrNull(values[45]),
    pb: numberOrNull(values[46]),
    limitUp: numberOrNull(values[47]),
    limitDown: numberOrNull(values[48]),
    volumeRatio: numberOrNull(values[49]),
    peStatic: numberOrNull(values[52]),
    industry: base.industry,
    listDate: base.listDate,
    updatedAt: new Date().toISOString(),
    source: base.source,
  };
}

export async function fetchStockKline(input: string, period: 'day' | 'week' | 'year', count = 320): Promise<KlinePoint[]> {
  const security = resolveSecurity(input);
  const { prefixed } = security;

  // Eastmoney daily rows include f61, the exchange-reported daily turnover
  // rate. Tencent is retained as a fallback, but its K-line rows only contain
  // OHLCV and therefore cannot provide this field.
  if (period === 'day' && inferType(security.code, security.market) === 'stock') {
    try {
      const eastmoneyPoints = await fetchEastmoneyDailyKline(input, count);
      if (eastmoneyPoints.length > 0) return eastmoneyPoints;
    } catch {
      // Fall back to Tencent so the price chart remains available when the
      // richer upstream endpoint is temporarily unavailable.
    }
  }

  // Tencent's direct `year` interval only returns the current partial year. Pull
  // monthly bars instead, then aggregate them so long-lived stocks retain history.
  const upstreamPeriod = period === 'year' ? 'month' : period;
  const upstreamCount = period === 'year' ? 500 : Math.min(Math.max(count, 30), 800);
  const params = new URLSearchParams({
    param: `${prefixed},${upstreamPeriod},,,${upstreamCount},qfq`,
    r: Math.random().toString(),
  });
  const response = await fetchWithRetry(`${TENCENT_KLINE_URL}?${params.toString()}`, {
    headers: { ...BROWSER_HEADERS, Referer: 'https://stock.qq.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`腾讯 K 线接口 HTTP ${response.status}`);
  const payload = await response.json() as { data?: Record<string, Record<string, unknown[][]>> };
  const node = payload.data?.[prefixed] ?? {};
  const rows = node[`qfq${upstreamPeriod}`] ?? node[upstreamPeriod] ?? [];
  const points: KlinePoint[] = rows.flatMap((row) => {
    if (row.length < 6) return [];
    const [date, open, close, high, low, volume] = row;
    const values = [open, close, high, low, volume].map(Number);
    return typeof date === 'string' && values.every(Number.isFinite)
      ? [{ date, open: values[0], close: values[1], high: values[2], low: values[3], volume: values[4] }]
      : [];
  });

  // 降级链：东财 K 线（含 f61）→ 新浪（akshare，补全历史每日换手率）→ 腾讯行情快照（仅补最新一天实时值）
  // 腾讯 K 线本身只返回 OHLCV，无换手率；故在东财降级后优先用新浪补全全部交易日，
  // 最后才用腾讯行情快照兜底“最新一天”的实时换手率。
  if (period === 'day' && inferType(security.code, security.market) === 'stock' && points.length > 0) {
    // 第二级：新浪（akshare）补全历史每日换手率
    try {
      const sinaMap = await fetchSinaTurnoverSeries(security);
      if (sinaMap.size > 0) {
        for (const point of points) {
          if (point.turnoverRatePct == null) {
            const tr = sinaMap.get(point.date);
            if (tr != null) point.turnoverRatePct = tr;
          }
        }
      }
    } catch {
      // 新浪源不可用（如未安装 akshare）时静默跳过，继续走腾讯行情快照兜底。
    }

    // 第三级：腾讯行情快照仅补最新一天的实时换手率（新浪未覆盖当天时使用）
    const latest = points[points.length - 1];
    if (latest.turnoverRatePct == null) {
      try {
        const quote = await fetchStockQuote(input, false);
        if (quote.turnoverPct != null) {
          points[points.length - 1] = { ...latest, turnoverRatePct: quote.turnoverPct };
        }
      } catch {
        // 行情快照也不可用时保留无换手率的点，不影响价格图表展示。
      }
    }
  }

  if (period !== 'year') return points;

  const grouped = new Map<string, KlinePoint>();
  for (const point of points) {
    const year = point.date.slice(0, 4);
    const existing = grouped.get(year);
    if (!existing) grouped.set(year, { ...point, date: `${year}-12-31` });
    else {
      existing.close = point.close;
      existing.high = Math.max(existing.high, point.high);
      existing.low = Math.min(existing.low, point.low);
      existing.volume += point.volume;
    }
  }
  return Array.from(grouped.values()).slice(-30);
}

async function fetchEastmoneyDailyKline(input: string, count: number): Promise<KlinePoint[]> {
  const { code, market } = resolveSecurity(input);
  const marketCode = market === 'SH' ? '1' : '0';
  const params = new URLSearchParams({
    secid: `${marketCode}.${code}`,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: '101',
    fqt: '1',
    end: '20500101',
    lmt: String(Math.min(Math.max(count, 30), 800)),
  });
  const response = await eastmoneyGet(EASTMONEY_KLINE_URL, params, 'https://quote.eastmoney.com/');
  if (!response.ok) throw new Error(`东方财富 K 线接口 HTTP ${response.status}`);
  const payload = await response.json() as { data?: { klines?: unknown } };
  return parseEastmoneyDailyKlines(payload.data?.klines);
}

export function parseEastmoneyDailyKlines(input: unknown): KlinePoint[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((row) => {
    const fields = String(row).split(',');
    if (fields.length < 11) return [];
    const [date, open, close, high, low, volume, , , , , turnoverRatePct] = fields;
    const prices = [open, close, high, low, volume].map(Number);
    const rate = numberOrNull(turnoverRatePct);
    if (!date || prices.some((value) => !Number.isFinite(value))) return [];
    return [{
      date,
      open: prices[0],
      close: prices[1],
      high: prices[2],
      low: prices[3],
      volume: prices[4],
      ...(rate == null ? {} : { turnoverRatePct: rate }),
    }];
  });
}

export async function fetchStockIntraday(input: string): Promise<KlinePoint[]> {
  const { prefixed } = resolveSecurity(input);
  const params = new URLSearchParams({
    code: prefixed,
    r: Math.random().toString(),
  });
  const response = await fetchWithRetry(`${TENCENT_MINUTE_URL}?${params.toString()}`, {
    headers: { ...BROWSER_HEADERS, Referer: 'https://stock.qq.com/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`腾讯分时接口 HTTP ${response.status}`);
  const payload = await response.json() as {
    data?: Record<string, {
      data?: { date?: string; data?: string[] };
      qt?: Record<string, string[]>;
    }>;
  };
  const node = payload.data?.[prefixed];
  const rows = node?.data?.data ?? [];
  const tradeDate = String(node?.data?.date ?? new Date().toISOString().slice(0, 10).replaceAll('-', ''));
  const datePrefix = /^\d{8}$/.test(tradeDate)
    ? `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`
    : new Date().toISOString().slice(0, 10);

  let previousVolume = 0;
  return rows.flatMap((row) => {
    const fields = row.trim().split(/\s+/);
    if (fields.length < 2) return [];
    const rawTime = fields[0];
    const price = Number(fields[1]);
    const rawVolume = Number(fields[2] ?? 0);
    if (!/^\d{4}$/.test(rawTime) || !Number.isFinite(price)) return [];
    const cumulativeVolume = Number.isFinite(rawVolume) ? rawVolume : 0;
    const volume = Math.max(0, cumulativeVolume - previousVolume);
    previousVolume = cumulativeVolume;
    const time = `${datePrefix} ${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}`;
    return [{
      date: time,
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
    }];
  });
}

export async function fetchResearchReports(input: string, limit = 20): Promise<ResearchReport[]> {
  const code = normalizeCode(input);
  const params = new URLSearchParams({
    industryCode: '*', pageSize: String(Math.min(limit, 50)), industry: '*', rating: '*',
    ratingChange: '*', beginTime: '2020-01-01', endTime: '2030-01-01', pageNo: '1',
    fields: '', qType: '0', orgCode: '', code, rcode: '', p: '1', pageNum: '1', pageNumber: '1',
  });
  const response = await eastmoneyGet(EASTMONEY_REPORT_URL, params, 'https://data.eastmoney.com/');
  const payload = await response.json() as { data?: Array<Record<string, unknown>> };
  return (payload.data ?? []).slice(0, limit).map((item) => {
    const infoCode = String(item.infoCode ?? '');
    return {
      title: String(item.title ?? ''),
      publishDate: String(item.publishDate ?? '').slice(0, 10),
      organization: String(item.orgSName ?? ''),
      rating: String(item.emRatingName ?? ''),
      industry: String(item.indvInduName ?? ''),
      infoCode,
      pdfUrl: infoCode ? `https://pdf.dfcfw.com/pdf/H3_${infoCode}_1.pdf` : null,
    };
  });
}
