import { parseLooseJson } from './looseJson.js';
import { limiterForHost } from './rateLimiter.js';
import {
  parseSseDragonTigerRows,
  parseSzseDragonTigerDetail,
  parseSzseDragonTigerRows,
  type OfficialDragonTigerResult,
} from '../officialDragonTigerParsers.js';

const SSE_URL = 'https://query.sse.com.cn/marketdata/tradedata/queryAllTradeOpenDate.do';
const SZSE_URL = 'https://www.szse.cn/api/report/ShowReport/data';

export async function fetchOfficialDragonTiger(date?: string): Promise<OfficialDragonTigerResult> {
  const results = await Promise.allSettled([fetchSse(date), fetchSzse(date)]);
  const successful = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (!successful.length) {
    const reasons = results.map((result) => result.status === 'rejected' ? String(result.reason) : '').filter(Boolean);
    throw new Error(`沪深交易所龙虎榜备源均不可用：${reasons.join('; ')}`);
  }
  const merged = {
    items: successful.flatMap((result) => result.items),
    seats: successful.flatMap((result) => result.seats),
  };
  const targetDate = date ?? merged.items.map((item) => item.tradeDate).sort().at(-1);
  const items = merged.items.filter((item) => item.tradeDate === targetDate)
    .sort((a, b) => (b.netBuyAmt ?? Number.NEGATIVE_INFINITY) - (a.netBuyAmt ?? Number.NEGATIVE_INFINITY))
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const ids = new Set(items.map((item) => item.tradeId));
  return { items, seats: merged.seats.filter((seat) => ids.has(seat.tradeId)) };
}

export async function fetchOfficialStockDragonTiger(code: string, date?: string): Promise<OfficialDragonTigerResult> {
  const market = await fetchOfficialDragonTiger(date);
  const items = market.items.filter((item) => item.code === code);
  const seats = market.seats.filter((seat) => seat.code === code);
  for (const item of items.filter((entry) => entry.sourceKey === 'szse')) {
    const detail = await fetchSzseDetail(item);
    Object.assign(item, detail.items[0]);
    seats.push(...detail.seats);
  }
  return { items, seats };
}

async function fetchSse(date?: string): Promise<OfficialDragonTigerResult> {
  const callback = `officialSse${Date.now()}`;
  const text = await fetchText(SSE_URL, {
    jsonCallBack: callback,
    token: 'QUERY',
    tradeDate: date?.replace(/-/g, '') ?? '',
    flag: '1',
  }, 'https://www.sse.com.cn/disclosure/diclosure/public/dailydata/');
  const payload = parseLooseJson(text) as { pageHelp?: { data?: Array<Record<string, unknown>> } };
  return parseSseDragonTigerRows(payload.pageHelp?.data ?? []);
}

async function fetchSzse(date?: string): Promise<OfficialDragonTigerResult> {
  const first = await fetchSzsePage(1, date);
  const inferredDate = date ?? String(first.data[0]?.dqrq ?? '');
  const pages = Math.min(20, Number(first.pages ?? 1));
  const rows = [...first.data];
  for (let page = 2; page <= pages; page += 1) {
    rows.push(...(await fetchSzsePage(page, inferredDate)).data);
  }
  return parseSzseDragonTigerRows(rows);
}

async function fetchSzsePage(page: number, date?: string): Promise<{
  data: Array<Record<string, unknown>>;
  pages: number;
}> {
  const params: Record<string, string> = {
    SHOWTYPE: 'JSON', CATALOGID: '1842_xxpl_after', TABKEY: 'tab1', PAGENO: String(page),
  };
  if (date) {
    params.txtStart = date;
    params.txtEnd = date;
  }
  const payload = parseLooseJson(await fetchText(SZSE_URL, params, 'https://www.szse.cn/disclosure/deal/public/')) as Array<{
    metadata?: { pagecount?: number };
    data?: Array<Record<string, unknown>>;
  }>;
  return { data: payload[0]?.data ?? [], pages: Number(payload[0]?.metadata?.pagecount ?? 1) };
}

async function fetchSzseDetail(item: OfficialDragonTigerResult['items'][number]): Promise<OfficialDragonTigerResult> {
  const payload = parseLooseJson(await fetchText(SZSE_URL, {
    SHOWTYPE: 'JSON', CATALOGID: '1842_detal', TABKEY: 'tab1,tab2',
    DQRQ: item.tradeDate, ZQDM: item.code, ZBDM: item.changeType ?? '',
  }, 'https://www.szse.cn/disclosure/deal/public/')) as Array<{
    metadata?: { tabkey?: string };
    data?: Array<Record<string, unknown>>;
  }>;
  return parseSzseDragonTigerDetail(payload, item);
}

async function fetchText(url: string, params: Record<string, string>, referer: string): Promise<string> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return limiterForHost(target.hostname).run(async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
            Accept: 'application/json,text/javascript,*/*;q=0.8', Referer: referer,
          },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('official exchange request failed');
  });
}
