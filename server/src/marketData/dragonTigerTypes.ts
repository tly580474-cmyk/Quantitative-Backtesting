export type MainlandExchange = 'SH' | 'SZ' | 'BJ';

export interface DragonTigerMarketItem {
  tradeId: string;
  tradeDate: string;
  rank: number;
  code: string;
  name: string;
  exchange: MainlandExchange;
  explanation: string;
  changeType: string | null;
  netBuyAmt: number | null;
  buyAmt: number | null;
  sellAmt: number | null;
  billboardDealAmt: number | null;
  closePrice: number | null;
  changePct: number | null;
  turnoverRate: number | null;
  sourceKey: 'eastmoney' | 'sse' | 'szse';
  sourceFingerprint: string;
}

export interface DragonTigerSeat {
  tradeId: string;
  tradeDate: string;
  code: string;
  side: 'buy' | 'sell';
  rank: number;
  operateDeptCode: string | null;
  seatName: string;
  buyAmt: number | null;
  sellAmt: number | null;
  netAmt: number | null;
  isInstitutional: boolean;
  sourceKey: 'eastmoney' | 'sse' | 'szse';
  sourceFingerprint: string;
}

export interface DragonTigerMarketSnapshot {
  tradeDate: string;
  items: DragonTigerMarketItem[];
  total: number;
  updatedAt: string;
  source: string;
  stale?: boolean;
}

export interface DragonTigerStockRecord extends DragonTigerMarketItem {
  buySeats: DragonTigerSeat[];
  sellSeats: DragonTigerSeat[];
}

export interface DragonTigerStockDetail {
  code: string;
  name: string;
  records: DragonTigerStockRecord[];
  updatedAt: string;
}
