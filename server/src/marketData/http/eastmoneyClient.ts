import { parseLooseJson } from './looseJson.js';
import { limiterForHost } from './rateLimiter.js';

export const EASTMONEY_DATACENTER_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'X-Requested-With': 'XMLHttpRequest',
};

export async function limitedFetchText(
  url: string,
  options: {
    params?: Record<string, string>;
    referer: string;
    method?: 'GET' | 'POST';
    body?: string | URLSearchParams;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<string> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.params ?? {})) target.searchParams.set(key, value);
  const limiter = limiterForHost(target.hostname);
  return limiter.run(async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(target, {
          method: options.method ?? 'GET',
          body: options.body,
          headers: { ...BROWSER_HEADERS, Referer: options.referer, ...options.headers },
          signal: AbortSignal.timeout(options.timeoutMs ?? 18_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 450 * attempt + Math.floor(Math.random() * 180)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Eastmoney request failed');
  });
}

export async function limitedFetchJson<T = unknown>(
  url: string,
  params: Record<string, string>,
  referer: string,
): Promise<T> {
  return parseLooseJson(await limitedFetchText(url, { params, referer })) as T;
}

export interface EastmoneyDataCenterResponse {
  success?: boolean;
  code?: number;
  message?: string;
  result?: {
    pages?: number;
    count?: number;
    data?: Array<Record<string, unknown>>;
  };
  data?: Array<Record<string, unknown>>;
}

export async function eastmoneyDataCenterQuery(options: {
  reportName: string;
  filter?: string;
  sortColumns: string;
  sortTypes?: '1' | '-1';
  pageNumber?: number;
  pageSize?: number;
}): Promise<{ rows: Array<Record<string, unknown>>; pages: number; count: number }> {
  const data = await limitedFetchJson<EastmoneyDataCenterResponse>(EASTMONEY_DATACENTER_URL, {
    reportName: options.reportName,
    columns: 'ALL',
    filter: options.filter ?? '',
    pageNumber: String(options.pageNumber ?? 1),
    pageSize: String(options.pageSize ?? 100),
    sortColumns: options.sortColumns,
    sortTypes: options.sortTypes ?? '-1',
    source: 'WEB',
    client: 'WEB',
  }, 'https://data.eastmoney.com/');
  if (data.success === false || (data.code != null && data.code !== 0)) {
    throw new Error(`Eastmoney report ${options.reportName} failed: ${data.message ?? data.code ?? 'unknown'}`);
  }
  return {
    rows: Array.isArray(data.result?.data) ? data.result.data : Array.isArray(data.data) ? data.data : [],
    pages: Number(data.result?.pages ?? 0),
    count: Number(data.result?.count ?? 0),
  };
}
