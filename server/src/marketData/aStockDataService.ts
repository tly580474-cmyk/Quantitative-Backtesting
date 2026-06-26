import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TENCENT_QUOTE_URL = 'https://qt.gtimg.cn/q=';
const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const TENCENT_MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
const TENCENT_SEARCH_URL = 'https://smartbox.gtimg.cn/s3/';
const EASTMONEY_REPORT_URL = 'https://reportapi.eastmoney.com/report/list';
const EASTMONEY_INFO_URL = 'https://push2.eastmoney.com/api/qt/stock/get';

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

export interface MarketSentimentOverview {
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
  distribution: Array<{ key: string; label: string; count: number; tone: 'up' | 'flat' | 'down' }>;
  mainNetInTrend: Array<{ time: string; value: number }>;
  factors: MarketSentimentFactor[];
  msi: number;
  status: 'euphoria' | 'bullish' | 'neutral' | 'bearish' | 'panic';
  statusLabel: string;
  notes: string[];
}

let marketSentimentCache: { data: MarketSentimentOverview; cachedAt: number } | null = null;
let marketSentimentInFlight: Promise<MarketSentimentOverview> | null = null;
let marketSentimentRefreshTimer: NodeJS.Timeout | null = null;
const MARKET_SENTIMENT_CACHE_MS = 10 * 60_000;
const AKSHARE_MARKET_SNAPSHOT_SCRIPT = fileURLToPath(new URL('./akshareMarketSnapshot.py', import.meta.url));
const MARKET_SENTIMENT_CACHE_FILE = fileURLToPath(new URL('../../.cache/market-sentiment.json', import.meta.url));

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
    try {
      const response = await fetch(`${url}?${params.toString()}`, {
        headers: { ...BROWSER_HEADERS, Referer: referer },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`东方财富接口 HTTP ${response.status}`);
      return response;
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

export async function fetchMarketSentimentOverview(): Promise<MarketSentimentOverview> {
  const [rowsResult, hs300KlineResult] = await Promise.allSettled([
    fetchAkshareAStockRows(),
    fetchStockKline('sh000300', 'day', 28).catch(() => []),
  ]);
  const rows = rowsResult.status === 'fulfilled' ? rowsResult.value : [];
  const hs300Kline = hs300KlineResult.status === 'fulfilled' ? hs300KlineResult.value : [];
  const dataNotes: string[] = [];
  if (rowsResult.status === 'rejected') {
    const reason = rowsResult.reason instanceof Error ? rowsResult.reason.message : '未知错误';
    dataNotes.push(`AKShare 全市场涨跌分布暂不可用：${reason}`);
  }
  if (hs300KlineResult.status === 'rejected') {
    dataNotes.push('沪深300波动数据暂不可用。');
  }
  const stocks = rows.filter((row) => {
    const name = String(row.f14 ?? '');
    return name && !/ST|退/.test(name);
  });

  let advancers = 0;
  let decliners = 0;
  let flat = 0;
  let upLimit = 0;
  let downLimit = 0;
  let mainNetInYuan = 0;
  let totalAmountYuan = 0;
  const buckets = {
    upLimit: 0,
    up5: 0,
    up1: 0,
    up0: 0,
    flat: 0,
    down0: 0,
    down1: 0,
    down5: 0,
    downLimit: 0,
  };

  for (const row of stocks) {
    const changePct = numberOrNull(row.f3);
    const amountYuan = numberOrNull(row.f6) ?? 0;
    const mainYuan = numberOrNull(row.f62) ?? 0;
    totalAmountYuan += amountYuan;
    mainNetInYuan += mainYuan;
    if (changePct == null) continue;
    if (changePct > 0) advancers += 1;
    else if (changePct < 0) decliners += 1;
    else flat += 1;

    if (changePct >= 9.8) { upLimit += 1; buckets.upLimit += 1; }
    else if (changePct >= 5) buckets.up5 += 1;
    else if (changePct >= 1) buckets.up1 += 1;
    else if (changePct > 0) buckets.up0 += 1;
    else if (changePct === 0) buckets.flat += 1;
    else if (changePct > -1) buckets.down0 += 1;
    else if (changePct > -5) buckets.down1 += 1;
    else if (changePct > -9.8) buckets.down5 += 1;
    else { downLimit += 1; buckets.downLimit += 1; }
  }

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

  const a = (advancers + decliners) > 0 ? ((advancers - decliners) / (advancers + decliners)) * 100 : 0;
  const b = ((upLimit - downLimit) / (upLimit + downLimit + 1)) * 100;
  const d = hs300AmplitudePct != null && hs300Amplitude20dPct
    ? (1 - hs300AmplitudePct / hs300Amplitude20dPct) * 100
    : 0;

  const factors: MarketSentimentFactor[] = [
    buildFactor('A', '涨跌家数', a, 0.60, 'live', '(上涨家数-下跌家数)/(上涨家数+下跌家数)*100', '全市场个股多空力量基础'),
    buildFactor('B', '涨跌停情绪', b, 0.40, 'estimated', '(涨停家数-跌停家数)/(涨停家数+跌停家数+1)*100', '以涨跌幅阈值近似识别极端情绪'),
  ];
  const msi = round(factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0));
  const status = sentimentStatus(msi);

  return {
    updatedAt: new Date().toISOString(),
    total: stocks.length,
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
    distribution: [
      { key: 'upLimit', label: '涨停', count: buckets.upLimit, tone: 'up' },
      { key: 'up5', label: '涨幅>5%', count: buckets.up5, tone: 'up' },
      { key: 'up1', label: '5-1%', count: buckets.up1, tone: 'up' },
      { key: 'up0', label: '1-0%', count: buckets.up0, tone: 'up' },
      { key: 'flat', label: '平盘', count: buckets.flat, tone: 'flat' },
      { key: 'down0', label: '0--1%', count: buckets.down0, tone: 'down' },
      { key: 'down1', label: '1--5%', count: buckets.down1, tone: 'down' },
      { key: 'down5', label: '5%--跌停', count: buckets.down5, tone: 'down' },
      { key: 'downLimit', label: '跌停', count: buckets.downLimit, tone: 'down' },
    ],
    mainNetInTrend: buildMainNetInTrend(round(mainNetInYuan / 100000000)),
    factors,
    msi,
    ...status,
    notes: [
      ...dataNotes,
      '全市场涨跌分布数据源：AKShare stock_zh_a_spot。',
      '涨停/跌停家数使用涨跌幅阈值近似，待接入交易所涨跌停状态后可替换为精确口径。',
      'MSI = 0.6 × 涨跌家数因子 A + 0.4 × 涨跌停情绪因子 B。',
    ],
  };
}

function buildPendingMarketSentimentOverview(): MarketSentimentOverview {
  const factors: MarketSentimentFactor[] = [
    buildFactor('A', '涨跌家数', 0, 0.60, 'neutral', '(上涨家数-下跌家数)/(上涨家数+下跌家数)*100', '等待全市场快照刷新'),
    buildFactor('B', '涨跌停情绪', 0, 0.40, 'neutral', '(涨停家数-跌停家数)/(涨停家数+跌停家数+1)*100', '等待全市场快照刷新'),
  ];
  return {
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
      { key: 'upLimit', label: '涨停', count: 0, tone: 'up' },
      { key: 'up5', label: '涨幅>5%', count: 0, tone: 'up' },
      { key: 'up1', label: '5-1%', count: 0, tone: 'up' },
      { key: 'up0', label: '1-0%', count: 0, tone: 'up' },
      { key: 'flat', label: '平盘', count: 0, tone: 'flat' },
      { key: 'down0', label: '0--1%', count: 0, tone: 'down' },
      { key: 'down1', label: '1--5%', count: 0, tone: 'down' },
      { key: 'down5', label: '5%--跌停', count: 0, tone: 'down' },
      { key: 'downLimit', label: '跌停', count: 0, tone: 'down' },
    ],
    mainNetInTrend: buildMainNetInTrend(0),
    factors,
    msi: 0,
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
    if (!parsed.data || typeof parsed.cachedAt !== 'number') return null;
    return { data: parsed.data, cachedAt: parsed.cachedAt };
  } catch {
    return null;
  }
}

async function writeMarketSentimentDiskCache(data: MarketSentimentOverview, cachedAt: number): Promise<void> {
  await mkdir(fileURLToPath(new URL('../../.cache/', import.meta.url)), { recursive: true });
  await writeFile(MARKET_SENTIMENT_CACHE_FILE, JSON.stringify({ data, cachedAt }), 'utf8');
}

function refreshMarketSentimentInBackground(): void {
  if (marketSentimentInFlight) return;
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
  marketSentimentInFlight.catch(() => undefined);
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
    const data = await fetchMarketSentimentOverview();
    const cachedAt = Date.now();
    marketSentimentCache = { data, cachedAt };
    await writeMarketSentimentDiskCache(data, cachedAt).catch(() => undefined);
    ensureMarketSentimentRefreshLoop();
    return data;
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
  refreshMarketSentimentInBackground();
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
  const { prefixed } = resolveSecurity(input);
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
  const points = rows.flatMap((row) => {
    if (row.length < 6) return [];
    const [date, open, close, high, low, volume] = row;
    const values = [open, close, high, low, volume].map(Number);
    return typeof date === 'string' && values.every(Number.isFinite)
      ? [{ date, open: values[0], close: values[1], high: values[2], low: values[3], volume: values[4] }]
      : [];
  });
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
