import { BROWSER_HEADERS } from './eastmoneyClient.js';

const CNINFO_SEARCH_URL = 'https://www.cninfo.com.cn/new/information/topSearch/query';
const CNINFO_ANN_URL = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';

export type MainlandMarket = 'SH' | 'SZ' | 'BJ';

export interface CninfoAnnouncement {
  id: string;
  code: string;
  name: string;
  title: string;
  publishedAt: string;
  url?: string;
  type?: string;
  raw: Record<string, unknown>;
}

export async function fetchCninfoAnnouncements(
  code: string,
  market: MainlandMarket,
  pageSize = 10,
): Promise<CninfoAnnouncement[]> {
  const stock = await resolveCninfoStock(code);
  const params = new URLSearchParams({
    stock: stock.orgId ? `${code},${stock.orgId}` : code,
    searchkey: '',
    category: '',
    pageNum: '1',
    pageSize: String(pageSize),
    column: market === 'SH' ? 'sse' : market === 'BJ' ? 'bj' : 'szse',
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
      Referer: stock.orgId
        ? `https://www.cninfo.com.cn/new/disclosure/stock?stockCode=${code}&orgId=${stock.orgId}`
        : 'https://www.cninfo.com.cn/new/disclosure/stock',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: params,
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new Error(`巨潮公告 HTTP ${response.status}`);
  const data = await response.json() as { announcements?: Array<Record<string, unknown>> };
  return (data.announcements ?? []).slice(0, pageSize).map((row) => ({
    id: String(row.announcementId ?? row.adjunctUrl ?? ''),
    code: String(row.secCode ?? code),
    name: String(row.secName ?? ''),
    title: stripMarkup(String(row.shortTitle ?? row.announcementTitle ?? row.title ?? '公告')),
    publishedAt: formatCninfoDate(row.announcementTime),
    url: row.adjunctUrl ? `https://static.cninfo.com.cn/${row.adjunctUrl}` : undefined,
    type: row.announcementTypeName ? String(row.announcementTypeName) : undefined,
    raw: row,
  }));
}

async function resolveCninfoStock(code: string): Promise<{ orgId?: string }> {
  const params = new URLSearchParams({ keyWord: code, maxNum: '10' });
  const response = await fetch(`${CNINFO_SEARCH_URL}?${params.toString()}`, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, Referer: 'https://www.cninfo.com.cn/new/disclosure/stock' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`巨潮证券检索 HTTP ${response.status}`);
  const rows = await response.json() as Array<Record<string, unknown>>;
  const matched = rows.find((row) => String(row.code ?? row.secCode ?? row.stockCode ?? '') === code);
  const orgId = String(matched?.orgId ?? '');
  return orgId ? { orgId } : {};
}

function formatCninfoDate(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const text = String(value ?? '').trim();
  if (!text) return '';
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000_000) return new Date(numeric).toISOString();
  return text;
}

function stripMarkup(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}
