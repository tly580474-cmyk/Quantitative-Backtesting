import { getTradeDateStatus } from '../marketData/repositories/calendarRepository.js';
import { getChinaMarketSession } from '../marketData/jobs/marketSession.js';

export type MarketOpinionDayMode = 'trading' | 'non_trading' | 'skip';

// Published exchange calendar, never a statutory workday calendar.
// https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
const SSE_2026_CLOSURES = [
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];
const remoteCalendar = new Map<string, { isOpen: boolean; expiresAt: number }>();

export function publishedExchangeStatus(date: string): boolean | null {
  if (!/^2026-\d{2}-\d{2}$/.test(date)) return null;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return ![0, 6].includes(weekday) && !SSE_2026_CLOSURES.some(([start, end]) => date >= start && date <= end);
}

/** Local rows are currently derived from past daily bars, so future/current
 * dates may be absent. Supplement missing rows with the published SSE calendar
 * or Tushare trade_cal; never derive today's pre-open status from missing bars. */
export async function getMarketOpinionTradeDateStatus(
  market: string,
  date: string,
  dependencies: { readStored?: typeof getTradeDateStatus; fetchImpl?: typeof fetch; token?: string } = {},
): Promise<boolean | null> {
  const stored = await (dependencies.readStored ?? getTradeDateStatus)(market, date);
  if (stored != null) return stored;
  const published = publishedExchangeStatus(date);
  if (published != null) return published;
  const cached = remoteCalendar.get(date);
  if (cached && cached.expiresAt > Date.now()) return cached.isOpen;
  const token = dependencies.token ?? process.env.TUSHARE_TOKEN ?? '';
  if (!token.trim()) return null;
  const compactDate = date.replaceAll('-', '');
  const response = await (dependencies.fetchImpl ?? fetch)('https://api.tushare.pro', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_name: 'trade_cal', token,
      params: { exchange: 'SSE', start_date: compactDate, end_date: compactDate }, fields: 'cal_date,is_open' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`交易日历查询失败：HTTP ${response.status}`);
  const payload = await response.json() as { code?: number; data?: { fields?: string[]; items?: unknown[][] } };
  if (payload.code !== 0) throw new Error('交易日历查询失败，请检查 Tushare 配置或权限');
  const fields = payload.data?.fields ?? [];
  const dateIndex = fields.indexOf('cal_date');
  const openIndex = fields.indexOf('is_open');
  const row = payload.data?.items?.find(item => item[dateIndex] === compactDate);
  if (!row || ![0, 1, '0', '1'].includes(row[openIndex] as number | string)) return null;
  const isOpen = Number(row[openIndex]) === 1;
  remoteCalendar.set(date, { isOpen, expiresAt: Date.now() + 3_600_000 });
  return isOpen;
}

/** Use the exchange calendar, including weekday holidays and closed weekends. */
export async function resolveMarketOpinionDayMode(
  now = new Date(),
  skipNonTradingDays = true,
  readStatus: typeof getTradeDateStatus = getMarketOpinionTradeDateStatus,
): Promise<MarketOpinionDayMode> {
  const session = getChinaMarketSession(now);
  // A-share exchanges do not open on weekends, including statutory makeup workdays.
  const isWeekend = session.weekday === 0 || session.weekday === 6;
  const status = isWeekend ? false : await readStatus('SH', session.tradeDate);
  if (status == null) throw new Error(`交易日历缺失：${session.tradeDate}，停止本次观点推送`);
  return status ? 'trading' : skipNonTradingDays ? 'skip' : 'non_trading';
}
