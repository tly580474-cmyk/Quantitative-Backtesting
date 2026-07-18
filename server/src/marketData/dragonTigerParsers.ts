import { createHash } from 'node:crypto';
import type { DragonTigerMarketItem, DragonTigerSeat, MainlandExchange } from './dragonTigerTypes.js';

export function parseDragonTigerMarketRows(rows: Array<Record<string, unknown>>): DragonTigerMarketItem[] {
  return rows.map((row, index) => {
    const tradeDate = text(row.TRADE_DATE).slice(0, 10);
    const code = text(row.SECURITY_CODE);
    const explanation = text(row.EXPLANATION ?? row.EXPLAIN);
    const changeType = nullableText(row.CHANGE_TYPE);
    const tradeId = text(row.TRADE_ID) || hash(`${tradeDate}|${code}|${changeType ?? ''}|${explanation}`);
    return {
      tradeId,
      tradeDate,
      rank: index + 1,
      code,
      name: text(row.SECURITY_NAME_ABBR ?? row.SECURITY_NAME),
      exchange: inferExchange(code, row.TRADE_MARKET_CODE ?? row.MARKET),
      explanation,
      changeType,
      netBuyAmt: nullableNumber(row.BILLBOARD_NET_AMT ?? row.NET_BS_AMT),
      buyAmt: nullableNumber(row.BILLBOARD_BUY_AMT ?? row.SUM_BUY_AMT),
      sellAmt: nullableNumber(row.BILLBOARD_SELL_AMT ?? row.SUM_SELL_AMT),
      billboardDealAmt: nullableNumber(row.BILLBOARD_DEAL_AMT),
      closePrice: nullableNumber(row.CLOSE_PRICE),
      changePct: nullableNumber(row.CHANGE_RATE),
      turnoverRate: nullableNumber(row.TURNOVERRATE),
      sourceKey: 'eastmoney',
      sourceFingerprint: hash(`eastmoney|${tradeId}`),
    };
  });
}

export function parseDragonTigerSeatRows(
  rows: Array<Record<string, unknown>>,
  side: 'buy' | 'sell',
): DragonTigerSeat[] {
  return rows.map((row, index) => {
    const tradeId = text(row.TRADE_ID);
    const code = text(row.SECURITY_CODE);
    const operateDeptCode = nullableText(row.OPERATEDEPT_CODE);
    const seatName = text(row.OPERATEDEPT_NAME) || '未知席位';
    return {
      tradeId,
      tradeDate: text(row.TRADE_DATE).slice(0, 10),
      code,
      side,
      rank: index + 1,
      operateDeptCode,
      seatName,
      buyAmt: nullableNumber(row.BUY),
      sellAmt: nullableNumber(row.SELL),
      netAmt: nullableNumber(row.NET),
      isInstitutional: operateDeptCode === '0' || /机构专用/.test(seatName),
      sourceKey: 'eastmoney',
      sourceFingerprint: hash(`eastmoney|${tradeId}|${side}|${operateDeptCode ?? seatName}|${index + 1}`),
    };
  });
}

function inferExchange(code: string, marketValue: unknown): MainlandExchange {
  const market = text(marketValue).toUpperCase();
  if (market.includes('北京') || market === 'BJ' || /^[489]/.test(code)) return 'BJ';
  if (market.includes('上海') || market === 'SH' || /^[6]/.test(code)) return 'SH';
  return 'SZ';
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
