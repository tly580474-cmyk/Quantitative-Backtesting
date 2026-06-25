import {
  fetchStockQuote,
  type StockQuote,
} from './aStockDataService.js';

const EASTMONEY_DATACENTER_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const EASTMONEY_SECURITIES_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const EASTMONEY_PUSH2_URL = 'https://push2.eastmoney.com/api/qt';
const EASTMONEY_PUSH2HIS_URL = 'https://push2his.eastmoney.com/api/qt';
const CNINFO_SEARCH_URL = 'https://www.cninfo.com.cn/new/information/topSearch/query';
const CNINFO_ANN_URL = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'X-Requested-With': 'XMLHttpRequest',
};

const INDUSTRY_ALIASES: Record<string, string[]> = {
  证券: ['证券', '券商', '券商概念', '证券公司'],
  银行: ['银行', '银行业'],
  保险: ['保险', '保险业'],
  半导体: ['半导体', '芯片', '集成电路'],
  通信: ['通信', '通信设备', '通信服务'],
  医药: ['医药', '医疗', '生物医药'],
  白酒: ['白酒', '酿酒'],
  房地产: ['房地产', '地产'],
};

export type SevenLayerStatus = 'ok' | 'partial' | 'degraded';

export interface SevenLayerRecord {
  source: string;
  title: string;
  date?: string;
  url?: string;
  summary?: string;
  metrics?: Record<string, unknown>;
  raw?: unknown;
}

export interface SevenLayerSection {
  key: 'signal' | 'capital' | 'fundamental' | 'announcement';
  title: string;
  status: SevenLayerStatus;
  summary: string;
  sources: string[];
  records: SevenLayerRecord[];
  errors: string[];
}

export interface SevenLayerSnapshot {
  code: string;
  market: 'SH' | 'SZ' | 'BJ';
  secid: string;
  name: string;
  updatedAt: string;
  sections: SevenLayerSection[];
}

export type SevenLayerSectionKey = SevenLayerSection['key'];

interface SecurityRef {
  code: string;
  market: 'SH' | 'SZ' | 'BJ';
  prefixed: string;
  secid: string;
}

interface SourceResult {
  source: string;
  records: SevenLayerRecord[];
  error?: string;
}

let limitedQueue: Promise<void> = Promise.resolve();
let limitedLastCall = 0;

export async function fetchSevenLayerSnapshot(input: string): Promise<SevenLayerSnapshot> {
  const security = resolveSecurity(input);
  const quote = await fetchStockQuote(input).catch(() => null);

  const [signals, capital, fundamentals, announcements] = await Promise.all([
    loadSignalLayer(security, quote),
    loadCapitalLayer(security),
    loadFundamentalLayer(security),
    loadAnnouncementLayer(security),
  ]);

  const name = quote?.name ?? security.code;
  return {
    code: security.code,
    market: security.market,
    secid: security.secid,
    name,
    updatedAt: new Date().toISOString(),
    sections: [
      buildSection('signal', '信号', signals, '同花顺热点/北向/龙虎榜/解禁/行业线索'),
      buildSection('capital', '资金面', capital, '融资融券/大宗交易/股东户数/分钟资金流/120日资金流'),
      buildSection('fundamental', '基础数据', fundamentals, '公司画像/估值股本/核心财务/财报摘要'),
      buildSection('announcement', '公告', announcements, '巨潮公告检索'),
    ],
  };
}

export async function fetchSevenLayerSection(input: string, section: SevenLayerSectionKey): Promise<SevenLayerSection> {
  const security = resolveSecurity(input);
  const quote = section === 'signal'
    ? await fetchStockQuote(input).catch(() => null)
    : null;

  switch (section) {
    case 'signal':
      return buildSection('signal', '信号', await loadSignalLayer(security, quote), '同花顺热点/北向/龙虎榜/解禁/行业线索');
    case 'capital':
      return buildSection('capital', '资金面', await loadCapitalLayer(security), '融资融券/大宗交易/股东户数/分钟资金流/120日资金流');
    case 'fundamental':
      return buildSection('fundamental', '基础数据', await loadFundamentalLayer(security), '公司画像/估值股本/核心财务/财报摘要');
    case 'announcement':
      return buildSection('announcement', '公告', await loadAnnouncementLayer(security), '巨潮公告检索');
  }
}

function buildSection(
  key: SevenLayerSection['key'],
  title: string,
  results: SourceResult[],
  fallbackSummary: string,
): SevenLayerSection {
  const records = results.flatMap((item) => item.records);
  const errors = results.flatMap((item) => item.error ? [`${item.source}: ${item.error}`] : []);
  const okSources = results.filter((item) => item.records.length > 0).map((item) => item.source);
  return {
    key,
    title,
    status: records.length > 0 && errors.length === 0 ? 'ok' : records.length > 0 ? 'partial' : 'degraded',
    summary: records.length > 0 ? `${okSources.join('、')} 已返回 ${records.length} 条` : `${fallbackSummary} 暂无可展示记录`,
    sources: results.map((item) => item.source),
    records,
    errors,
  };
}

async function loadSignalLayer(security: SecurityRef, quote: StockQuote | null): Promise<SourceResult[]> {
  return Promise.all([
    source('东财行业/题材资金', () => eastmoneyJson(`${EASTMONEY_PUSH2_URL}/clist/get`, {
      fid: 'f62',
      po: '1',
      pz: '200',
      pn: '1',
      np: '1',
      fltt: '2',
      invt: '2',
      fs: 'm:90+t:2,m:90+t:3',
      fields: 'f12,f14,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87',
    }).then((data) => sectorFundRecords(dataToRows(data), quote))),
    source('东财北向资金', () => eastmoneyDataCenter('RPT_MUTUAL_STOCK_NORTHSTA', security.code, 'TRADE_DATE', 6)
      .then((rows) => mapRows('东财北向资金', rows, ['TRADE_DATE', 'SECURITY_NAME', 'HOLD_MARKET_CAP', 'HOLD_SHARES', 'ADD_MARKET_CAP']))),
    source('东财龙虎榜', () => eastmoneyDataCenter('RPT_DAILYBILLBOARD_DETAILS', security.code, 'TRADE_DATE', 8)
      .then((rows) => mapRows('东财龙虎榜', rows, ['TRADE_DATE', 'SECURITY_NAME_ABBR', 'EXPLANATION', 'NET_BUY_AMT', 'BILLBOARD_DEAL_AMT']))),
    source('东财解禁', () => eastmoneyDataCenter('RPT_LIFT_STAGE', security.code, 'LIFT_DATE', 8)
      .then((rows) => mapRows('东财解禁', rows, ['LIFT_DATE', 'SECURITY_NAME_ABBR', 'LIFT_MARKET_CAP', 'LIFT_NUM', 'FREE_SHARES_RATIO']))),
  ]);
}

async function loadCapitalLayer(security: SecurityRef): Promise<SourceResult[]> {
  return Promise.all([
    source('东财分钟资金流', () => eastmoneyJson(`${EASTMONEY_PUSH2HIS_URL}/stock/fflow/kline/get`, {
      secid: security.secid,
      klt: '1',
      lmt: '60',
      fields1: 'f1,f2,f3,f7',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63',
    }).then((data) => klineTextRecords('东财分钟资金流', data?.data?.klines, ['time', 'mainNetIn', 'smallNetIn', 'midNetIn', 'largeNetIn', 'superNetIn']))),
    source('东财120日资金流', () => eastmoneyJson(`${EASTMONEY_PUSH2HIS_URL}/stock/fflow/kline/get`, {
      secid: security.secid,
      klt: '101',
      lmt: '120',
      fields1: 'f1,f2,f3,f7',
      fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63',
    }).then((data) => klineTextRecords('东财120日资金流', data?.data?.klines, ['date', 'mainNetIn', 'smallNetIn', 'midNetIn', 'largeNetIn', 'superNetIn'])), 120),
    source('东财融资融券', () => eastmoneyDataCenter('RPTA_WEB_RZRQ_GGMX', security.code, 'DATE', 60, 'SCODE')
      .then((rows) => mapRows('东财融资融券', rows, ['DATE', 'SECNAME', 'RZYE', 'RQYL', 'RZRQYE'])), 60),
    source('东财大宗交易', () => eastmoneyDataCenter('RPT_BLOCKTRADE_STA', security.code, 'TRADE_DATE', 8)
      .then((rows) => mapRows('东财大宗交易', rows, ['TRADE_DATE', 'SECURITY_NAME_ABBR', 'DEAL_PRICE', 'DEAL_VOLUME', 'DEAL_AMT']))),
    source('东财股东户数', () => eastmoneyDataCenter('RPT_HOLDERNUM_DET', security.code, 'END_DATE', 60)
      .then((rows) => mapRows('东财股东户数', rows, ['END_DATE', 'SECURITY_NAME_ABBR', 'HOLDER_NUM', 'HOLDER_NUM_RATIO', 'AVG_MARKET_CAP'])), 60),
  ]);
}

async function loadFundamentalLayer(security: SecurityRef): Promise<SourceResult[]> {
  return Promise.all([
    source('公司画像与估值', () => eastmoneyJson(`${EASTMONEY_PUSH2_URL}/stock/get`, {
      secid: security.secid,
      fltt: '2',
      invt: '2',
      fields: 'f57,f58,f84,f85,f116,f117,f127,f128,f129,f162,f167,f168,f169,f170,f189',
    }).then((data) => [companyProfileRecord(security, data?.data ?? {})])),
    source('东财核心财务', () => eastmoneySecurityDataCenter('RPT_F10_FINANCE_MAINFINADATA', `(SECUCODE="${security.code}.${security.market}")`, 'REPORT_DATE', 4)
      .then(financialMainRecords), 4),
    source('东财财报摘要', () => eastmoneySecurityDataCenter('RPT_LICO_FN_CPD', `(SECURITY_CODE="${security.code}")`, 'REPORTDATE', 4)
      .then(financialSummaryRecords), 4),
  ]);
}

async function loadAnnouncementLayer(security: SecurityRef): Promise<SourceResult[]> {
  return Promise.all([
    source('巨潮公告', async () => {
      const cninfoStock = await resolveCninfoStock(security);
      const params = new URLSearchParams({
        stock: cninfoStock.stock,
        searchkey: '',
        category: '',
        pageNum: '1',
        pageSize: '10',
        column: cninfoColumn(security.market),
        tabName: 'fulltext',
        seDate: '',
        sortName: '',
        sortType: '',
        isHLtitle: 'true',
      });
      const response = await fetch(CNINFO_ANN_URL, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          Referer: cninfoStock.orgId
            ? `https://www.cninfo.com.cn/new/disclosure/stock?stockCode=${security.code}&orgId=${cninfoStock.orgId}`
            : 'https://www.cninfo.com.cn/new/disclosure/stock',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: params,
        signal: AbortSignal.timeout(18000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { announcements?: Array<Record<string, unknown>> };
      return (data.announcements ?? []).slice(0, 10).map((row) => ({
        source: '巨潮公告',
        title: stripMarkup(String(row.shortTitle ?? row.announcementTitle ?? row.title ?? '公告')),
        date: formatCninfoDate(row.announcementTime),
        url: row.adjunctUrl ? `https://static.cninfo.com.cn/${row.adjunctUrl}` : undefined,
        metrics: pick(row, ['secCode', 'secName', 'announcementTypeName', 'adjunctType', 'announcementId']),
        raw: row,
      }));
    }),
  ]);
}

async function resolveCninfoStock(security: SecurityRef): Promise<{ stock: string; orgId?: string }> {
  const params = new URLSearchParams({
    keyWord: security.code,
    maxNum: '10',
  });
  const response = await fetch(`${CNINFO_SEARCH_URL}?${params.toString()}`, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      Referer: 'https://www.cninfo.com.cn/new/disclosure/stock',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`巨潮证券检索 HTTP ${response.status}`);
  const rows = await response.json() as Array<Record<string, unknown>>;
  const matched = rows.find((row) => String(row.code ?? row.secCode ?? row.stockCode ?? '') === security.code);
  const orgId = String(matched?.orgId ?? '');
  return orgId ? { stock: `${security.code},${orgId}`, orgId } : { stock: security.code };
}

function cninfoColumn(market: SecurityRef['market']): string {
  if (market === 'SH') return 'sse';
  if (market === 'BJ') return 'bj';
  return 'szse';
}

async function source(name: string, run: () => Promise<SevenLayerRecord[]>, limit = 12): Promise<SourceResult> {
  try {
    const records = await run();
    return { source: name, records: records.slice(0, limit) };
  } catch (error) {
    return { source: name, records: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function eastmoneyJson(url: string, params: Record<string, string>): Promise<any> {
  return limitedFetchJson(url, params, 'https://quote.eastmoney.com/');
}

async function eastmoneyDataCenter(
  reportName: string,
  code: string,
  sortColumn: string,
  pageSize: number,
  filterColumn = 'SECURITY_CODE',
): Promise<Record<string, unknown>[]> {
  const filters = `(${filterColumn}="${code}")`;
  const data = await limitedFetchJson(EASTMONEY_DATACENTER_URL, {
    reportName,
    columns: 'ALL',
    filter: filters,
    pageNumber: '1',
    pageSize: String(pageSize),
    sortColumns: sortColumn,
    sortTypes: '-1',
    source: 'WEB',
    client: 'WEB',
  }, 'https://data.eastmoney.com/');
  return Array.isArray(data?.result?.data) ? data.result.data : Array.isArray(data?.data) ? data.data : [];
}

async function eastmoneySecurityDataCenter(
  reportName: string,
  filter: string,
  sortColumn: string,
  pageSize: number,
): Promise<Record<string, unknown>[]> {
  const data = await limitedFetchJson(EASTMONEY_SECURITIES_URL, {
    reportName,
    columns: 'ALL',
    filter,
    pageNumber: '1',
    pageSize: String(pageSize),
    sortColumns: sortColumn,
    sortTypes: '-1',
    source: 'HSF10',
    client: 'PC',
  }, 'https://emweb.securities.eastmoney.com/');
  return Array.isArray(data?.result?.data) ? data.result.data : Array.isArray(data?.data) ? data.data : [];
}

async function limitedFetchJson(url: string, params: Record<string, string>, referer: string): Promise<any> {
  const run = limitedQueue.then(async () => {
    const wait = Math.max(0, 900 - (Date.now() - limitedLastCall));
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 180));
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${url}?${new URLSearchParams(params).toString()}`, {
          headers: { ...BROWSER_HEADERS, Referer: referer },
          signal: AbortSignal.timeout(18000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        return parseLooseJson(text);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(450 * attempt + Math.floor(Math.random() * 180));
      } finally {
        limitedLastCall = Date.now();
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Eastmoney request failed');
  });
  limitedQueue = run.then(() => undefined, () => undefined);
  return run;
}

function parseLooseJson(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const match = trimmed.match(/^[^(]*\(([\s\S]*)\);?$/);
  if (match) return JSON.parse(match[1]);
  return JSON.parse(trimmed);
}

function mapRows(sourceName: string, rows: Record<string, unknown>[], preferredKeys: string[]): SevenLayerRecord[] {
  return rows.map((row) => ({
    source: sourceName,
    title: String(row.SECURITY_NAME_ABBR ?? row.SECURITY_NAME ?? row.SECNAME ?? row.SE_NAME ?? row.SECURITY_CODE ?? sourceName),
    date: String(row.TRADE_DATE ?? row.DATE ?? row.END_DATE ?? row.LIFT_DATE ?? row.EX_DIVIDEND_DATE ?? row.NOTICE_DATE ?? '').slice(0, 10) || undefined,
    summary: preferredKeys.map((key) => row[key] == null ? null : `${key}: ${row[key]}`).filter(Boolean).join('；'),
    metrics: pick(row, preferredKeys),
    raw: row,
  }));
}

function klineTextRecords(sourceName: string, klines: unknown, fields: string[]): SevenLayerRecord[] {
  if (!Array.isArray(klines)) return [];
  return klines.slice(-12).reverse().map((line) => {
    const values = String(line).split(',');
    const metrics: Record<string, unknown> = {};
    fields.forEach((key, index) => { metrics[key] = values[index]; });
    return {
      source: sourceName,
      title: `${sourceName} ${values[0] ?? ''}`,
      date: String(values[0] ?? '').slice(0, 10),
      metrics,
    };
  });
}

function companyProfileRecord(security: SecurityRef, row: Record<string, unknown>): SevenLayerRecord {
  const name = String(row.f58 ?? security.code);
  return {
    source: '公司画像与估值',
    title: `${name} 公司画像`,
    date: formatEightDigitDate(row.f189),
    metrics: {
      stockCode: row.f57 ?? security.code,
      stockName: name,
      industry: row.f127,
      region: row.f128,
      concepts: row.f129,
      listDate: formatEightDigitDate(row.f189),
      totalShares: row.f84,
      floatShares: row.f85,
      totalMarketCap: row.f116,
      floatMarketCap: row.f117,
      peTtm: row.f162,
      pb: row.f167,
      ps: row.f168,
      peg: row.f169,
      dividendYield: row.f170,
    },
    raw: row,
  };
}

function financialMainRecords(rows: Record<string, unknown>[]): SevenLayerRecord[] {
  return rows.map((row) => ({
    source: '东财核心财务',
    title: String(row.REPORT_DATE_NAME ?? row.REPORT_TYPE ?? '核心财务指标'),
    date: String(row.REPORT_DATE ?? '').slice(0, 10) || undefined,
    metrics: {
      reportPeriod: row.REPORT_DATE_NAME ?? row.REPORT_TYPE,
      revenue: row.TOTALOPERATEREVE,
      grossProfit: row.MLR,
      netProfit: row.PARENTNETPROFIT,
      deductNetProfit: row.KCFJCXSYJLR,
      revenueGrowth: row.TOTALOPERATEREVETZ,
      netProfitGrowth: row.PARENTNETPROFITTZ,
      roe: row.ROEJQ,
      grossMargin: row.XSMLL,
      netMargin: row.XSJLL,
      debtRatio: row.ZCFZL,
      eps: row.EPSJB,
      bps: row.BPS,
      operatingCashPerShare: row.MGJYXJJE,
    },
    raw: row,
  }));
}

function financialSummaryRecords(rows: Record<string, unknown>[]): SevenLayerRecord[] {
  return rows.map((row) => ({
    source: '东财财报摘要',
    title: String(row.DATATYPE ?? row.REPORTDATE ?? '财报摘要'),
    date: String(row.REPORTDATE ?? row.NOTICE_DATE ?? '').slice(0, 10) || undefined,
    metrics: {
      reportPeriod: row.DATATYPE ?? row.QDATE,
      revenue: row.TOTAL_OPERATE_INCOME,
      netProfit: row.PARENT_NETPROFIT,
      eps: row.BASIC_EPS,
      roe: row.WEIGHTAVG_ROE,
      grossMargin: row.XSMLL,
      revenueGrowth: row.YSTZ,
      netProfitGrowth: row.SJLTZ,
      bps: row.BPS,
      operatingCashPerShare: row.MGJYXJJE,
      industry: row.PUBLISHNAME ?? row.BOARD_NAME,
    },
    raw: row,
  }));
}

function sectorFundRecords(rows: Record<string, unknown>[], quote: StockQuote | null): SevenLayerRecord[] {
  const records = rows.map((row) => ({
    source: '东财行业/题材资金',
    title: String(row.f14 ?? row.BK_NAME ?? '热点板块'),
    summary: quote?.industry ? `个股行业：${quote.industry}` : undefined,
    metrics: pick(row, ['f3', 'f62', 'f184', 'f66', 'f69']),
    raw: row,
  }));
  if (!quote?.industry) return records.slice(0, 8);
  return records.filter((record) => matchesIndustry(record.title, quote.industry ?? '')).slice(0, 8);
}

function matchesIndustry(boardName: string, industry: string): boolean {
  const board = normalizeIndustryText(boardName);
  const keywords = industryKeywords(industry);
  return keywords.some((keyword) => board.includes(keyword) || keyword.includes(board));
}

function industryKeywords(industry: string): string[] {
  const normalized = normalizeIndustryText(industry);
  const aliases = Object.entries(INDUSTRY_ALIASES)
    .filter(([key]) => {
      const aliasKey = normalizeIndustryText(key);
      return normalized.includes(aliasKey) || aliasKey.includes(normalized);
    })
    .flatMap(([, values]) => values.map(normalizeIndustryText));
  return Array.from(new Set([normalized, ...aliases])).filter((keyword) => keyword.length >= 2);
}

function normalizeIndustryText(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/[()（）·/\\-]/g, '')
    .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/g, '')
    .replace(/[IVX]+$/gi, '')
    .replace(/行业|概念|板块|指数/g, '');
}

function dataToRows(data: any): Record<string, unknown>[] {
  const diff = data?.data?.diff;
  if (Array.isArray(diff)) return diff;
  if (diff && typeof diff === 'object') return Object.values(diff) as Record<string, unknown>[];
  return [];
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => row[key] != null).map((key) => [key, row[key]]));
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function formatCninfoDate(value: unknown): string | undefined {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return new Date(num).toISOString().slice(0, 10);
  const text = String(value ?? '');
  return text ? text.slice(0, 10) : undefined;
}

function formatEightDigitDate(value: unknown): string | undefined {
  const text = String(value ?? '');
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : undefined;
}

function resolveSecurity(input: string): SecurityRef {
  const value = input.trim().toLowerCase();
  const prefixMatch = value.match(/^(sh|sz|bj)(\d{6})$/);
  const suffixMatch = value.match(/^(\d{6})\.(sh|sz|bj)$/);
  const code = prefixMatch?.[2] ?? suffixMatch?.[1] ?? value.match(/(\d{6})/)?.[1];
  if (!code) throw new Error('请输入有效的 6 位 A 股代码');
  const rawMarket = prefixMatch?.[1] ?? suffixMatch?.[2];
  const market = (rawMarket?.toUpperCase() ?? (/^[689]/.test(code) ? 'SH' : /^[48]/.test(code) ? 'BJ' : 'SZ')) as 'SH' | 'SZ' | 'BJ';
  const prefix = market === 'SH' ? 'sh' : market === 'BJ' ? 'bj' : 'sz';
  const secidPrefix = market === 'SH' ? '1' : '0';
  return { code, market, prefixed: `${prefix}${code}`, secid: `${secidPrefix}.${code}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
