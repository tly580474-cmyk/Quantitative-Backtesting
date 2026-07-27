export type TradeSide = 'buy' | 'sell';
export type AshareBoard = 'main' | 'chinext' | 'star' | 'bse';
export type ListingLifecycle = 'pending_listing' | 'early_listing' | 'score_warmup' | 'normal';
export type SecurityTradingStatus = 'pending' | 'active' | 'suspended' | 'delisted';
export type ChinaMarketPhase =
  | 'pre_open'
  | 'opening_auction'
  | 'continuous_trading'
  | 'lunch_break'
  | 'closing_auction'
  | 'closed';

export interface PriceLimitRuleInput {
  securityCode: string;
  listDate?: string | null;
  tradeDate?: string | null;
  tradingDayNumber?: number | null;
  isRiskWarning?: boolean;
}

export interface PriceLimitRule {
  board: AshareBoard;
  limitRatio: number | null;
  detectionThreshold: number | null;
  ipoNoLimitTradingDays: number;
  stage: 'ipo_no_limit' | 'normal_limit';
  ruleVersion: string;
}

export interface ListingLifecycleInput {
  listDate?: string | null;
  asOf?: string | null;
  validTradingDays: number;
  scoreWarmupDays: number;
  securityCode: string;
}

export interface ListingLifecycleResult {
  lifecycle: ListingLifecycle;
  tradingDayNumber: number | null;
  ipoNoLimitTradingDays: number;
}

export interface TradabilityInput extends PriceLimitRuleInput {
  securityStatus: SecurityTradingStatus;
  marketPhase: ChinaMarketPhase;
  previousClose?: number | null;
  orderPrice?: number | null;
}

export interface TradabilityResult {
  tradable: boolean;
  reasonCode: string | null;
  reason: string | null;
  priceLimitRule: PriceLimitRule;
  limitUp: number | null;
  limitDown: number | null;
  ruleVersion: string;
}

export const TRADING_RULES_VERSION: string;
export const PRICE_LIMIT_RULES_VERSION: string;
export const TRADING_PRECISION: Readonly<{
  priceDecimals: number;
  moneyDecimals: number;
  quantityDecimals: number;
  stockLotSize: number;
  priceTick: number;
}>;

export function roundDecimal(value: number, decimals: number): number;
export function roundMoney(value: number): number;
export function roundPrice(value: number): number;
export function applySlippage(price: number, side: TradeSide, slippageBps: number): number;
export function calculateCommission(
  amount: number,
  commissionRate: number,
  minimumCommission: number,
): number;
export function calculateSellTax(amount: number, sellTaxRate: number): number;
export function normalizeStockBuyQuantity(requestedQuantity: number, lotSize?: number): number;
export function normalizeStockSellQuantity(
  requestedQuantity: number,
  positionQuantity: number,
  lotSize?: number,
): number;
export function normalizeSecurityCode(securityCode: string): string;
export function inferAshareBoard(securityCode: string): AshareBoard;
export function ipoNoLimitTradingDays(board: AshareBoard, listDate?: string | null): number;
export function normalPriceLimitRatio(board: AshareBoard, isRiskWarning?: boolean): number;
export function resolvePriceLimitRule(input: PriceLimitRuleInput): PriceLimitRule;
export function resolveListingLifecycle(input: ListingLifecycleInput): ListingLifecycleResult;
export function calculatePriceLimitPrices(
  previousClose: number | null | undefined,
  rule: PriceLimitRule,
): { limitUp: number | null; limitDown: number | null };
export function evaluateAshareTradability(input: TradabilityInput): TradabilityResult;
