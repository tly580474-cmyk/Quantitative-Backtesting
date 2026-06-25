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
