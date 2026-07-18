import { createHash } from 'node:crypto';
import type { DragonTigerMarketItem, DragonTigerSeat } from './dragonTigerTypes.js';

export interface OfficialDragonTigerResult {
  items: DragonTigerMarketItem[];
  seats: DragonTigerSeat[];
}

export function parseSseDragonTigerRows(rows: Array<Record<string, unknown>>): OfficialDragonTigerResult {
  const items: DragonTigerMarketItem[] = [];
  const seats: DragonTigerSeat[] = [];
  for (const [index, row] of rows.entries()) {
    const code = text(row.secCode);
    const tradeDate = compactDate(row.tradeDate);
    if (!code || !tradeDate) continue;
    const reasonCode = text(row.refType);
    const explanation = sseReason(reasonCode);
    const tradeId = `sse:${tradeDate}:${code}:${reasonCode}`;
    const buyNames = split(row.branchNameB);
    const buyAmounts = split(row.branchTxAmtB).map(numberOf);
    const sellNames = split(row.branchNameS);
    const sellAmounts = split(row.branchTxAmtS).map(numberOf);
    const buyAmt = sum(buyAmounts);
    const sellAmt = sum(sellAmounts);
    items.push({
      tradeId, tradeDate, rank: index + 1, code, name: text(row.secAbbr), exchange: 'SH',
      explanation, changeType: reasonCode || null, netBuyAmt: buyAmt - sellAmt,
      buyAmt, sellAmt, billboardDealAmt: nullableNumber(row.secTxAmount), closePrice: null,
      changePct: null, turnoverRate: null, sourceKey: 'sse', sourceFingerprint: hash(`sse|${tradeId}`),
    });
    seats.push(...seatRows(tradeId, tradeDate, code, 'buy', buyNames, buyAmounts, 'sse'));
    seats.push(...seatRows(tradeId, tradeDate, code, 'sell', sellNames, sellAmounts, 'sse'));
  }
  return { items, seats };
}

export function parseSzseDragonTigerRows(rows: Array<Record<string, unknown>>): OfficialDragonTigerResult {
  const items = rows.flatMap<DragonTigerMarketItem>((row, index) => {
    const code = text(row.zqdm);
    const tradeDate = compactDate(row.dqrq);
    if (!code || !tradeDate) return [];
    const explanation = text(row.plyy);
    const detail = text(row.bz);
    const reasonCode = /ZBDM=([^&'"\s>]+)/i.exec(detail)?.[1] ?? null;
    const tradeId = `szse:${tradeDate}:${code}:${reasonCode ?? hash(explanation).slice(0, 12)}`;
    return [{
      tradeId, tradeDate, rank: index + 1, code, name: text(row.zqjc), exchange: 'SZ',
      explanation, changeType: reasonCode, netBuyAmt: null, buyAmt: null, sellAmt: null,
      billboardDealAmt: multiplyYi(row.cjje), closePrice: null, changePct: null, turnoverRate: null,
      sourceKey: 'szse', sourceFingerprint: hash(`szse|${tradeId}`),
    }];
  });
  return { items, seats: [] };
}

export function parseSzseDragonTigerDetail(
  payload: Array<{ metadata?: { tabkey?: string }; data?: Array<Record<string, unknown>> }>,
  item: DragonTigerMarketItem,
): OfficialDragonTigerResult {
  const summary = payload.find((part) => part.metadata?.tabkey === 'tab1')?.data?.[0];
  const seatData = payload.find((part) => part.metadata?.tabkey === 'tab2')?.data ?? [];
  const seats = seatData.flatMap<DragonTigerSeat>((row) => {
    const label = text(row.mmlb);
    const side = label.startsWith('买') ? 'buy' : label.startsWith('卖') ? 'sell' : null;
    const rank = Number(label.replace(/\D/g, ''));
    if (!side || !Number.isFinite(rank)) return [];
    const seatName = text(row.zsmc) || '未知席位';
    const buyAmt = nullableNumber(cleanNumber(row.mrje));
    const sellAmt = nullableNumber(cleanNumber(row.mcje));
    return [{
      tradeId: item.tradeId, tradeDate: item.tradeDate, code: item.code, side, rank,
      operateDeptCode: null, seatName, buyAmt, sellAmt,
      netAmt: buyAmt == null || sellAmt == null ? null : buyAmt - sellAmt,
      isInstitutional: /机构专用/.test(seatName), sourceKey: 'szse',
      sourceFingerprint: hash(`szse|${item.tradeId}|${side}|${rank}|${seatName}`),
    }];
  });
  const buySeats = seats.filter((seat) => seat.side === 'buy');
  const sellSeats = seats.filter((seat) => seat.side === 'sell');
  const buyAmt = sum(buySeats.map((seat) => seat.buyAmt ?? 0));
  const sellAmt = sum(sellSeats.map((seat) => seat.sellAmt ?? 0));
  return {
    items: [{
      ...item,
      explanation: text(summary?.plyy) || item.explanation,
      billboardDealAmt: nullableNumber(cleanNumber(summary?.cjje)) ?? item.billboardDealAmt,
      buyAmt, sellAmt, netBuyAmt: buyAmt - sellAmt,
    }],
    seats,
  };
}

function seatRows(
  tradeId: string, tradeDate: string, code: string, side: 'buy' | 'sell',
  names: string[], amounts: number[], sourceKey: 'sse' | 'szse',
): DragonTigerSeat[] {
  return names.slice(0, 5).map((seatName, index) => ({
    tradeId, tradeDate, code, side, rank: index + 1, operateDeptCode: null, seatName,
    buyAmt: side === 'buy' ? amounts[index] ?? null : null,
    sellAmt: side === 'sell' ? amounts[index] ?? null : null,
    netAmt: side === 'buy' ? amounts[index] ?? null : amounts[index] == null ? null : -amounts[index],
    isInstitutional: /机构专用/.test(seatName), sourceKey,
    sourceFingerprint: hash(`${sourceKey}|${tradeId}|${side}|${index + 1}|${seatName}`),
  }));
}

function sseReason(code: string): string {
  return ({
    '1': '连续三个交易日内涨幅偏离值累计达到20%', '2': '连续三个交易日内跌幅偏离值累计达到20%',
    '11': '日涨幅偏离值达到7%', '12': '日跌幅偏离值达到7%', '13': '日振幅达到15%',
    '14': '日换手率达到20%', '15': '无价格涨跌幅限制',
  } as Record<string, string>)[code] ?? `上交所交易公开信息（类型 ${code || '未知'}）`;
}

function compactDate(value: unknown): string {
  const digits = text(value).replace(/\D/g, '');
  return digits.length >= 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : '';
}

function split(value: unknown): string[] { return text(value).split(',').map((item) => item.trim()).filter(Boolean); }
function cleanNumber(value: unknown): string { return text(value).replace(/[^\d.-]/g, ''); }
function numberOf(value: unknown): number { return Number(cleanNumber(value)) || 0; }
function nullableNumber(value: unknown): number | null { const number = Number(value); return value == null || value === '' || !Number.isFinite(number) ? null : number; }
function multiplyYi(value: unknown): number | null { const number = nullableNumber(cleanNumber(value)); return number == null ? null : number * 100_000_000; }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function text(value: unknown): string { return value == null ? '' : String(value).replace(/&nbsp;/gi, ' ').trim(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
