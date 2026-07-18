import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { DragonTigerMarketItem, DragonTigerSeat } from '../dragonTigerTypes.js';

const { dragonTigerBillboards, dragonTigerSeats } = schema;
const CHUNK_SIZE = 200;

export async function upsertDragonTigerBillboards(items: DragonTigerMarketItem[]): Promise<Map<string, number>> {
  if (!items.length) return new Map();
  const fetchedAt = mysqlUtcNow();
  await getDb().transaction(async (tx) => {
    for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
      const rows = items.slice(offset, offset + CHUNK_SIZE).map((item) => ({
        tradeId: item.tradeId,
        tradeDate: item.tradeDate,
        securityCode: item.code,
        securityName: item.name,
        exchange: item.exchange,
        explanation: item.explanation || null,
        changeType: item.changeType,
        netBuyAmt: item.netBuyAmt,
        buyAmt: item.buyAmt,
        sellAmt: item.sellAmt,
        billboardDealAmt: item.billboardDealAmt,
        closePrice: item.closePrice,
        changePct: item.changePct,
        turnoverRate: item.turnoverRate,
        reasonCodes: item.changeType ? [item.changeType] : null,
        sourceKey: item.sourceKey,
        sourceFingerprint: item.sourceFingerprint,
        fetchedAt,
      }));
      await tx.insert(dragonTigerBillboards).values(rows).onDuplicateKeyUpdate({ set: {
        securityName: sql`VALUES(${dragonTigerBillboards.securityName})`,
        explanation: sql`VALUES(${dragonTigerBillboards.explanation})`,
        changeType: sql`VALUES(${dragonTigerBillboards.changeType})`,
        netBuyAmt: sql`VALUES(${dragonTigerBillboards.netBuyAmt})`,
        buyAmt: sql`VALUES(${dragonTigerBillboards.buyAmt})`,
        sellAmt: sql`VALUES(${dragonTigerBillboards.sellAmt})`,
        billboardDealAmt: sql`VALUES(${dragonTigerBillboards.billboardDealAmt})`,
        closePrice: sql`VALUES(${dragonTigerBillboards.closePrice})`,
        changePct: sql`VALUES(${dragonTigerBillboards.changePct})`,
        turnoverRate: sql`VALUES(${dragonTigerBillboards.turnoverRate})`,
        fetchedAt: sql`VALUES(${dragonTigerBillboards.fetchedAt})`,
      } });
    }
  });
  const rows = await getDb().select({
    id: dragonTigerBillboards.id,
    sourceKey: dragonTigerBillboards.sourceKey,
    tradeId: dragonTigerBillboards.tradeId,
  }).from(dragonTigerBillboards).where(inArray(dragonTigerBillboards.sourceFingerprint, items.map((item) => item.sourceFingerprint)));
  return new Map(rows.map((row) => [`${row.sourceKey}:${row.tradeId}`, row.id]));
}

export async function upsertDragonTigerSeats(
  seats: DragonTigerSeat[],
  billboardIds: Map<string, number>,
): Promise<void> {
  if (!seats.length) return;
  const fetchedAt = mysqlUtcNow();
  const rows = seats.flatMap((seat) => {
    const billboardId = billboardIds.get(`${seat.sourceKey}:${seat.tradeId}`);
    return billboardId == null ? [] : [{
      billboardId,
      tradeId: seat.tradeId,
      tradeDate: seat.tradeDate,
      securityCode: seat.code,
      seatName: seat.seatName,
      seatSide: seat.side,
      operateDeptCode: seat.operateDeptCode,
      buyAmt: seat.buyAmt,
      sellAmt: seat.sellAmt,
      netAmt: seat.netAmt,
      rank: seat.rank,
      isInstitutional: seat.isInstitutional ? 1 : 0,
      sourceKey: seat.sourceKey,
      sourceFingerprint: seat.sourceFingerprint,
      fetchedAt,
    }];
  });
  if (!rows.length) return;
  await getDb().insert(dragonTigerSeats).values(rows).onDuplicateKeyUpdate({ set: {
    buyAmt: sql`VALUES(${dragonTigerSeats.buyAmt})`,
    sellAmt: sql`VALUES(${dragonTigerSeats.sellAmt})`,
    netAmt: sql`VALUES(${dragonTigerSeats.netAmt})`,
    isInstitutional: sql`VALUES(${dragonTigerSeats.isInstitutional})`,
    fetchedAt: sql`VALUES(${dragonTigerSeats.fetchedAt})`,
  } });
}

export async function listDragonTigerByDate(tradeDate: string): Promise<DragonTigerMarketItem[]> {
  const rows = await getDb().select().from(dragonTigerBillboards)
    .where(eq(dragonTigerBillboards.tradeDate, tradeDate))
    .orderBy(desc(dragonTigerBillboards.netBuyAmt), dragonTigerBillboards.id);
  return rows.map((row, index) => ({
    tradeId: row.tradeId,
    tradeDate: row.tradeDate,
    rank: index + 1,
    code: row.securityCode,
    name: row.securityName,
    exchange: row.exchange as DragonTigerMarketItem['exchange'],
    explanation: row.explanation ?? '',
    changeType: row.changeType,
    netBuyAmt: row.netBuyAmt,
    buyAmt: row.buyAmt,
    sellAmt: row.sellAmt,
    billboardDealAmt: row.billboardDealAmt,
    closePrice: row.closePrice,
    changePct: row.changePct,
    turnoverRate: row.turnoverRate,
    sourceKey: row.sourceKey as DragonTigerMarketItem['sourceKey'],
    sourceFingerprint: row.sourceFingerprint,
  }));
}

export async function listDragonTigerStock(code: string, limit = 8): Promise<Array<{ item: DragonTigerMarketItem; billboardId: number }>> {
  const rows = await getDb().select().from(dragonTigerBillboards)
    .where(eq(dragonTigerBillboards.securityCode, code))
    .orderBy(desc(dragonTigerBillboards.tradeDate), desc(dragonTigerBillboards.id))
    .limit(limit);
  return rows.map((row, index) => ({ billboardId: row.id, item: {
    tradeId: row.tradeId,
    tradeDate: row.tradeDate,
    rank: index + 1,
    code: row.securityCode,
    name: row.securityName,
    exchange: row.exchange as DragonTigerMarketItem['exchange'],
    explanation: row.explanation ?? '',
    changeType: row.changeType,
    netBuyAmt: row.netBuyAmt,
    buyAmt: row.buyAmt,
    sellAmt: row.sellAmt,
    billboardDealAmt: row.billboardDealAmt,
    closePrice: row.closePrice,
    changePct: row.changePct,
    turnoverRate: row.turnoverRate,
    sourceKey: row.sourceKey as DragonTigerMarketItem['sourceKey'],
    sourceFingerprint: row.sourceFingerprint,
  } }));
}

export async function listSeatsByBillboardIds(ids: number[]): Promise<Map<number, DragonTigerSeat[]>> {
  if (!ids.length) return new Map();
  const rows = await getDb().select().from(dragonTigerSeats)
    .where(inArray(dragonTigerSeats.billboardId, ids))
    .orderBy(dragonTigerSeats.billboardId, dragonTigerSeats.seatSide, dragonTigerSeats.rank);
  const result = new Map<number, DragonTigerSeat[]>();
  for (const row of rows) {
    const collection = result.get(row.billboardId) ?? [];
    collection.push({
      tradeId: row.tradeId,
      tradeDate: row.tradeDate,
      code: row.securityCode,
      side: row.seatSide as DragonTigerSeat['side'],
      rank: row.rank,
      operateDeptCode: row.operateDeptCode,
      seatName: row.seatName,
      buyAmt: row.buyAmt,
      sellAmt: row.sellAmt,
      netAmt: row.netAmt,
      isInstitutional: row.isInstitutional === 1,
      sourceKey: row.sourceKey as DragonTigerSeat['sourceKey'],
      sourceFingerprint: row.sourceFingerprint,
    });
    result.set(row.billboardId, collection);
  }
  return result;
}

export async function latestDragonTigerTradeDate(): Promise<string | null> {
  const rows = await getDb().select({ tradeDate: dragonTigerBillboards.tradeDate })
    .from(dragonTigerBillboards).orderBy(desc(dragonTigerBillboards.tradeDate)).limit(1);
  return rows[0]?.tradeDate ?? null;
}

function mysqlUtcNow(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
