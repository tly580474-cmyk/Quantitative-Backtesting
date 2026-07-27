import {
  TRADING_PRECISION,
  TRADING_RULES_VERSION,
  type SecurityTradingStatus,
} from '../../../shared/trading-rules/index.js';

export const PAPER_TRADING_DOMAIN_VERSION = 'paper-trading-domain-2026.1';

export const PAPER_TRADING_ACCOUNTING_POLICY = Object.freeze({
  databaseMoneyType: 'DECIMAL(20,4)',
  databasePriceType: 'DECIMAL(20,4)',
  databaseQuantityType: 'DECIMAL(20,6)',
  moneyDecimals: TRADING_PRECISION.moneyDecimals,
  priceDecimals: TRADING_PRECISION.priceDecimals,
  quantityDecimals: TRADING_PRECISION.quantityDecimals,
  stockLotSize: TRADING_PRECISION.stockLotSize,
  sharedTradingRulesVersion: TRADING_RULES_VERSION,
});

export type PaperAccountStatus = 'active' | 'paused' | 'closed';
export type PaperOrderSide = 'buy' | 'sell';
export type PaperOrderType = 'market' | 'limit';
export type PaperTimeInForce = 'day';
export type PaperOrderStatus =
  | 'created'
  | 'validated'
  | 'accepted'
  | 'partially_filled'
  | 'filled'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface PaperSecurityContext {
  instrumentKey: number;
  securityCode: string;
  market: 'SH' | 'SZ' | 'BJ';
  securityStatus: SecurityTradingStatus;
  listDate: string | null;
  tradingDayNumber: number | null;
  isRiskWarning: boolean;
}

export interface PaperOrderDraft {
  accountId: string;
  instrumentKey: number;
  clientOrderId: string;
  side: PaperOrderSide;
  orderType: PaperOrderType;
  timeInForce: PaperTimeInForce;
  quantity: number;
  limitPrice: number | null;
  strategyBindingId?: string | null;
}

export interface PaperOrderState extends PaperOrderDraft {
  id: string;
  status: PaperOrderStatus;
  filledQuantity: number;
  averageFillPrice: number | null;
  rejectCode: string | null;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaperExecutionEvidence {
  executionRunId: string;
  quoteTime: string;
  quoteSource: string;
  ruleVersion: string;
  rawPrice: number;
  fillPrice: number;
  availableVolume: number | null;
}

const ALLOWED_ORDER_TRANSITIONS: Readonly<Record<PaperOrderStatus, readonly PaperOrderStatus[]>> = {
  created: ['validated', 'rejected'],
  validated: ['accepted', 'rejected'],
  accepted: ['partially_filled', 'filled', 'cancelled', 'expired'],
  partially_filled: ['partially_filled', 'filled', 'cancelled', 'expired'],
  filled: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

export function canTransitionPaperOrder(
  from: PaperOrderStatus,
  to: PaperOrderStatus,
): boolean {
  return ALLOWED_ORDER_TRANSITIONS[from].includes(to);
}

export function assertPaperOrderTransition(
  from: PaperOrderStatus,
  to: PaperOrderStatus,
): void {
  if (!canTransitionPaperOrder(from, to)) {
    throw new Error(`非法模拟委托状态转换：${from} -> ${to}`);
  }
}

export function isTerminalPaperOrderStatus(status: PaperOrderStatus): boolean {
  return status === 'filled'
    || status === 'rejected'
    || status === 'cancelled'
    || status === 'expired';
}
