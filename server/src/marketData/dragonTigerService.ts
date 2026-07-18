import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eastmoneyDataCenterQuery } from './http/eastmoneyClient.js';
import { fetchOfficialDragonTiger, fetchOfficialStockDragonTiger } from './http/officialDragonTigerClient.js';
import { parseDragonTigerMarketRows, parseDragonTigerSeatRows } from './dragonTigerParsers.js';
import type { DragonTigerMarketItem, DragonTigerMarketSnapshot, DragonTigerSeat, DragonTigerStockDetail } from './dragonTigerTypes.js';
import {
  latestDragonTigerTradeDate,
  listDragonTigerByDate,
  listDragonTigerStock,
  listSeatsByBillboardIds,
  upsertDragonTigerBillboards,
  upsertDragonTigerSeats,
} from './repositories/dragonTigerRepository.js';

const CACHE_MS = 5 * 60_000;
const serverRoot = process.cwd().replace(/[\\/]server$/, '') === process.cwd() ? resolve(process.cwd(), 'server') : process.cwd();
const CACHE_FILE = localModulePath('../../.cache/dragon-tiger-market.json', '.cache/dragon-tiger-market.json');
const memoryCache = new Map<string, { data: DragonTigerMarketSnapshot; cachedAt: number }>();
const inFlight = new Map<string, Promise<DragonTigerMarketSnapshot>>();

export async function getMarketBillboard(options: {
  date?: string;
  force?: boolean;
  dbOnline?: boolean;
} = {}): Promise<DragonTigerMarketSnapshot> {
  const requestedDate = options.date ? normalizeDate(options.date) : undefined;
  const key = requestedDate ?? 'latest';
  const cached = memoryCache.get(key);
  if (!options.force && cached && Date.now() - cached.cachedAt < CACHE_MS) return cached.data;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const operation = loadMarketBillboard(requestedDate, options).finally(() => inFlight.delete(key));
  inFlight.set(key, operation);
  return operation;
}

export async function getStockBillboard(
  inputCode: string,
  options: { force?: boolean; dbOnline?: boolean; includeLatestSeats?: boolean } = {},
): Promise<DragonTigerStockDetail> {
  const code = normalizeCode(inputCode);
  let records = options.dbOnline === false ? [] : await listDragonTigerStock(code, 8);
  if (options.force || !records.length) {
    let items: DragonTigerMarketItem[];
    let officialSeats: DragonTigerSeat[] = [];
    try {
      const response = await eastmoneyDataCenterQuery({
        reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
        filter: `(SECURITY_CODE="${code}")`,
        sortColumns: 'TRADE_DATE',
        pageSize: 20,
      });
      items = parseDragonTigerMarketRows(response.rows).slice(0, 8);
      if (!items.length) throw new Error(`东财未返回 ${code} 龙虎榜数据`);
    } catch {
      const official = await fetchOfficialStockDragonTiger(code);
      items = official.items.slice(0, 8);
      officialSeats = official.seats;
    }
    if (options.dbOnline !== false) {
      const ids = await upsertDragonTigerBillboards(items);
      if (officialSeats.length) await upsertDragonTigerSeats(officialSeats, ids);
    }
    records = options.dbOnline === false
      ? items.map((item, index) => ({ item, billboardId: -(index + 1) }))
      : await listDragonTigerStock(code, 8);
  }
  let seatsByBillboard = options.dbOnline === false
    ? new Map<number, Awaited<ReturnType<typeof listSeatsByBillboardIds>> extends Map<number, infer T> ? T : never>()
    : await listSeatsByBillboardIds(records.map((record) => record.billboardId));
  const latest = records[0];
  if (latest && options.includeLatestSeats !== false && !(seatsByBillboard.get(latest.billboardId)?.length)) {
    const seats = await fetchSeats(latest.item.tradeId, latest.item.tradeDate, code);
    if (options.dbOnline !== false) {
      const ids = await upsertDragonTigerBillboards([latest.item]);
      await upsertDragonTigerSeats(seats, ids);
      seatsByBillboard = await listSeatsByBillboardIds(records.map((record) => record.billboardId));
    } else {
      seatsByBillboard.set(latest.billboardId, seats);
    }
  }
  return {
    code,
    name: records[0]?.item.name ?? code,
    records: records.map(({ item, billboardId }) => {
      const seats = seatsByBillboard.get(billboardId) ?? [];
      return { ...item, buySeats: seats.filter((seat) => seat.side === 'buy'), sellSeats: seats.filter((seat) => seat.side === 'sell') };
    }),
    updatedAt: new Date().toISOString(),
  };
}

async function loadMarketBillboard(
  requestedDate: string | undefined,
  options: { force?: boolean; dbOnline?: boolean },
): Promise<DragonTigerMarketSnapshot> {
  try {
    if (!options.force && options.dbOnline !== false) {
      const date = requestedDate ?? await latestDragonTigerTradeDate();
      if (date) {
        const items = await listDragonTigerByDate(date);
        if (items.length) return remember(requestedDate ?? 'latest', snapshot(date, items, 'database'));
      }
    }
    const date = requestedDate ?? await latestRemoteTradeDate();
    const first = await eastmoneyDataCenterQuery({
      reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
      filter: `(TRADE_DATE>='${date}')(TRADE_DATE<='${date}')`,
      sortColumns: 'BILLBOARD_NET_AMT',
      pageSize: 500,
    });
    const rows = [...first.rows];
    for (let page = 2; page <= first.pages; page += 1) {
      const next = await eastmoneyDataCenterQuery({
        reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
        filter: `(TRADE_DATE>='${date}')(TRADE_DATE<='${date}')`,
        sortColumns: 'BILLBOARD_NET_AMT',
        pageNumber: page,
        pageSize: 500,
      });
      rows.push(...next.rows);
    }
    const items = parseDragonTigerMarketRows(rows);
    if (!items.length) throw new Error(`东财未返回 ${date} 龙虎榜数据`);
    if (options.dbOnline !== false) await upsertDragonTigerBillboards(items);
    const result = snapshot(date, items, 'eastmoney');
    await writeCache(result);
    return remember(requestedDate ?? 'latest', result);
  } catch (error) {
    try {
      const official = await fetchOfficialDragonTiger(requestedDate);
      if (official.items.length) {
        if (options.dbOnline !== false) {
          const ids = await upsertDragonTigerBillboards(official.items);
          await upsertDragonTigerSeats(official.seats, ids);
        }
        const date = official.items[0]!.tradeDate;
        const result = snapshot(date, official.items, 'sse+szse');
        await writeCache(result);
        return remember(requestedDate ?? 'latest', result);
      }
    } catch {
      // Continue to the last known local snapshot below.
    }
    const fallback = await readCache();
    if (fallback && (!requestedDate || fallback.tradeDate === requestedDate)) return remember(requestedDate ?? 'latest', { ...fallback, stale: true });
    throw error;
  }
}

async function latestRemoteTradeDate(): Promise<string> {
  const response = await eastmoneyDataCenterQuery({
    reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
    sortColumns: 'TRADE_DATE',
    pageSize: 1,
  });
  const date = String(response.rows[0]?.TRADE_DATE ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('东财未返回可用龙虎榜交易日');
  return date;
}

async function fetchSeats(tradeId: string, tradeDate: string, code: string) {
  try {
    const filter = `(TRADE_DATE='${tradeDate}')(SECURITY_CODE="${code}")(TRADE_ID="${tradeId}")`;
    const [buy, sell] = await Promise.all([
      eastmoneyDataCenterQuery({ reportName: 'RPT_BILLBOARD_DAILYDETAILSBUY', filter, sortColumns: 'BUY', pageSize: 10 }),
      eastmoneyDataCenterQuery({ reportName: 'RPT_BILLBOARD_DAILYDETAILSSELL', filter, sortColumns: 'SELL', pageSize: 10 }),
    ]);
    const seats = [...parseDragonTigerSeatRows(buy.rows.slice(0, 5), 'buy'), ...parseDragonTigerSeatRows(sell.rows.slice(0, 5), 'sell')];
    if (seats.length) return seats;
  } catch {
    // The official event identity is preserved below, so seats cannot be attached
    // to an unrelated Eastmoney event merely because the security/date match.
  }
  if (!tradeId.startsWith('sse:') && !tradeId.startsWith('szse:')) return [];
  const official = await fetchOfficialStockDragonTiger(code, tradeDate);
  return official.seats.filter((seat) => seat.tradeId === tradeId);
}

function snapshot(tradeDate: string, items: DragonTigerMarketSnapshot['items'], source: string): DragonTigerMarketSnapshot {
  return { tradeDate, items, total: items.length, updatedAt: new Date().toISOString(), source };
}

function remember(key: string, data: DragonTigerMarketSnapshot): DragonTigerMarketSnapshot {
  memoryCache.set(key, { data, cachedAt: Date.now() });
  memoryCache.set(data.tradeDate, { data, cachedAt: Date.now() });
  return data;
}

async function writeCache(data: DragonTigerMarketSnapshot): Promise<void> {
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(data), 'utf8');
}

async function readCache(): Promise<DragonTigerMarketSnapshot | null> {
  try { return JSON.parse(await readFile(CACHE_FILE, 'utf8')) as DragonTigerMarketSnapshot; } catch { return null; }
}

function normalizeCode(value: string): string {
  const match = value.match(/\d{6}/);
  if (!match) throw new Error('请输入有效的 6 位 A 股代码');
  return match[0];
}

function normalizeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期必须为 YYYY-MM-DD');
  return value;
}

function localModulePath(relativeUrl: string, fallbackFromServerRoot: string): string {
  try { return fileURLToPath(new URL(relativeUrl, import.meta.url)); } catch { return resolve(serverRoot, fallbackFromServerRoot); }
}
