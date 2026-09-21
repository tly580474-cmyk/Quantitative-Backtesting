import { getChinaMarketSession } from '../marketData/jobs/marketSession.js';
import { scoreHotSectorRows, type HotSectorSnapshot, type HotSectorSourceRow } from '../marketData/hotSectorService.js';
import type { MarketCapitalFlowSnapshot } from '../marketData/marketCapitalFlowService.js';

const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' };
export type OpinionCapitalFlowSnapshot = Omit<MarketCapitalFlowSnapshot, 'sampleCount' | 'total' | 'coveragePct'> & {
  sampleCount: number | null;
  total: number | null;
  coveragePct: number | null;
};

/** Mail-only fallback: never replace the stock-level cache with a different aggregation. */
export async function fetchOpinionCapitalFlow(tradeDate: string | null, now = new Date()): Promise<OpinionCapitalFlowSnapshot> {
  if (!tradeDate) throw new Error('大盘资金备用源缺少目标交易日');
  const session = getChinaMarketSession(now);
  const daily = session.phase === 'pre_open' || session.phase === 'closed' || session.minuteOfDay >= 15 * 60;
  const params = new URLSearchParams({
    lmt: daily ? '5' : '0', klt: daily ? '101' : '1', secid: '1.000001', secid2: '0.399001',
    fields1: 'f1,f2,f3,f7', fields2: 'f51,f52', ut: 'b2884a393a59ad64002292a3e90d46a5',
  });
  const endpoint = daily ? 'daykline' : 'kline';
  const response = await fetch(`https://push2his.eastmoney.com/api/qt/stock/fflow/${endpoint}/get?${params}`, {
    headers: HEADERS, signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`大盘资金备用源 HTTP ${response.status}`);
  const payload = await response.json() as { data?: { klines?: string[] } };
  return parseOpinionCapitalFlow(payload.data?.klines ?? [], tradeDate, daily, now);
}

export function parseOpinionCapitalFlow(lines: string[], tradeDate: string, daily: boolean, now: Date): OpinionCapitalFlowSnapshot {
  const latest = [...lines].sort().at(-1)?.split(',');
  const stamp = latest?.[0] ?? '';
  const amount = latest?.[1]?.trim();
  const validStamp = daily ? stamp === tradeDate : new RegExp(`^${tradeDate} \\d{2}:\\d{2}(:\\d{2})?$`).test(stamp);
  if (!validStamp || !amount || !Number.isFinite(Number(amount))) {
    throw new Error(`大盘资金备用源没有 ${tradeDate} 的有效数据`);
  }
  // A daily row is only allowed outside continuous trading. Never relabel yesterday as today.
  const session = getChinaMarketSession(now);
  if (daily && session.phase !== 'pre_open' && session.phase !== 'closed' && session.minuteOfDay < 15 * 60) {
    throw new Error('盘中不能使用缺少分钟时间戳的日资金数据');
  }
  const sourceTime = daily ? `${tradeDate}T15:00:00+08:00` : `${stamp.replace(' ', 'T')}+08:00`;
  const age = now.getTime() - Date.parse(sourceTime);
  if (!Number.isFinite(age) || age < -120_000) throw new Error('大盘资金备用源时间戳无效');
  if (!daily && age > 10 * 60_000) {
    if (!(session.phase === 'lunch' && stamp.startsWith(`${tradeDate} 11:30`))) {
      throw new Error('大盘资金备用源分钟快照已过期');
    }
  }
  return {
    mainNetInYi: Math.round(Number(amount) / 1_000_000) / 100,
    sampleCount: null, total: null, coveragePct: null,
    updatedAt: now.toISOString(), tradeDate,
    source: `东方财富沪深大盘资金${daily ? '日累计' : '分钟'}汇总（备用源；数据时点 ${sourceTime}；非逐股覆盖统计）`,
    stale: false,
  };
}

export function parseSinaSectorRows(text: string, type: 'industry' | 'concept'): HotSectorSourceRow[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('新浪板块备用源响应格式无效');
  // The response is a JS variable assignment; parse only JSON, never execute source text.
  const payload = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  return Object.values(payload).flatMap((value) => {
    if (typeof value !== 'string') return [];
    const fields = value.split(',');
    const [code, name] = fields;
    const changePct = Number(fields[5]);
    const amount = Number(fields[7]);
    if (!code || !name || !fields[5]?.trim() || !Number.isFinite(changePct) || !Number.isFinite(amount)) return [];
    return [{
      code, name, type, changePct, amountYi: amount / 100_000_000,
      mainNetInYi: null, mainNetRatio: null, advancers: null, decliners: null,
      leadingStock: fields[12] || null,
      leadingStockChangePct: fields[9]?.trim() && Number.isFinite(Number(fields[9])) ? Number(fields[9]) : null,
    }];
  });
}

export async function fetchOpinionHotSectors(): Promise<HotSectorSnapshot> {
  const sources = [
    ['industry', 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php'],
    ['concept', 'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class'],
  ] as const;
  const rows = (await Promise.all(sources.map(async ([type, url]) => {
    const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`新浪板块备用源 HTTP ${response.status}`);
    const result = parseSinaSectorRows(new TextDecoder('gb18030').decode(await response.arrayBuffer()), type);
    if (result.length < 5) throw new Error(`新浪 ${type} 板块备用源样本不足`);
    return result;
  }))).flat();
  return {
    items: scoreHotSectorRows(rows), total: rows.length, updatedAt: new Date().toISOString(), stale: false,
    source: '新浪行业/概念行情（备用源；按涨幅和成交活跃度排序；不提供板块主力资金和涨跌家数）',
  };
}

export async function withFreshFallback<T extends { stale?: boolean }>(
  primary: Promise<T>, fallback: () => Promise<T>, acceptsReference: (value: T) => boolean = () => false,
): Promise<T> {
  try {
    const result = await primary;
    if (!result.stale || acceptsReference(result)) return result;
  } catch {
    // Both missing and explicitly stale primary snapshots require a fresh alternative.
  }
  return fallback();
}
