export type AshareBoard = 'main' | 'chinext' | 'star' | 'bse';
export type ListingLifecycle = 'pending_listing' | 'early_listing' | 'score_warmup' | 'normal';

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

const MAINBOARD_REGISTRATION_FIRST_LISTING = '2023-04-10';
const CHINEXT_REGISTRATION_FIRST_LISTING = '2020-08-24';
const STAR_FIRST_LISTING = '2019-07-22';

/**
 * Resolves the price-limit regime from point-in-time listing information.
 *
 * Current official rules:
 * - Shanghai/Shenzhen IPOs under the registration regime: first five
 *   trading days have no daily price limit.
 * - Beijing Stock Exchange: only the first trading day has no daily limit.
 * - Normal limits are 10% main board, 20% ChiNext/STAR and 30% BSE.
 *
 * Historical pre-registration main-board IPO first-day rules are deliberately
 * not inferred without an explicit historical rule record.
 */
export function resolvePriceLimitRule(input: PriceLimitRuleInput): PriceLimitRule {
  const board = inferAshareBoard(input.securityCode);
  const noLimitDays = ipoNoLimitTradingDays(board, input.listDate);
  const inNoLimitStage = noLimitDays > 0
    && input.tradingDayNumber != null
    && input.tradingDayNumber >= 1
    && input.tradingDayNumber <= noLimitDays;
  const normalRatio = normalPriceLimitRatio(board, Boolean(input.isRiskWarning));
  return {
    board,
    limitRatio: inNoLimitStage ? null : normalRatio,
    detectionThreshold: inNoLimitStage ? null : normalRatio - 0.005,
    ipoNoLimitTradingDays: noLimitDays,
    stage: inNoLimitStage ? 'ipo_no_limit' : 'normal_limit',
    ruleVersion: 'cn-equity-price-limit-2026.1',
  };
}

export function inferAshareBoard(securityCode: string): AshareBoard {
  const code = normalizeCode(securityCode);
  if (/^(4|8|920)/.test(code)) return 'bse';
  if (/^(300|301)/.test(code)) return 'chinext';
  if (/^(688|689)/.test(code)) return 'star';
  return 'main';
}

export function ipoNoLimitTradingDays(
  board: AshareBoard,
  listDate?: string | null,
): number {
  if (!listDate) return 0;
  if (board === 'bse') return 1;
  if (board === 'star') return listDate >= STAR_FIRST_LISTING ? 5 : 0;
  if (board === 'chinext') {
    return listDate >= CHINEXT_REGISTRATION_FIRST_LISTING ? 5 : 0;
  }
  return listDate >= MAINBOARD_REGISTRATION_FIRST_LISTING ? 5 : 0;
}

export function normalPriceLimitRatio(
  board: AshareBoard,
  isRiskWarning = false,
): number {
  if (board === 'bse') return 0.30;
  if (board === 'chinext' || board === 'star') return 0.20;
  return isRiskWarning ? 0.05 : 0.10;
}

export function resolveListingLifecycle(input: {
  listDate?: string | null;
  asOf?: string | null;
  validTradingDays: number;
  scoreWarmupDays: number;
  securityCode: string;
}): {
  lifecycle: ListingLifecycle;
  tradingDayNumber: number | null;
  ipoNoLimitTradingDays: number;
} {
  const board = inferAshareBoard(input.securityCode);
  const noLimitDays = ipoNoLimitTradingDays(board, input.listDate);
  if (input.listDate && input.asOf && input.listDate > input.asOf) {
    return {
      lifecycle: 'pending_listing',
      tradingDayNumber: 0,
      ipoNoLimitTradingDays: noLimitDays,
    };
  }
  const tradingDayNumber = input.listDate ? input.validTradingDays : null;
  if (tradingDayNumber != null && tradingDayNumber > 0 && tradingDayNumber <= noLimitDays) {
    return {
      lifecycle: 'early_listing',
      tradingDayNumber,
      ipoNoLimitTradingDays: noLimitDays,
    };
  }
  if (input.validTradingDays < input.scoreWarmupDays) {
    return {
      lifecycle: 'score_warmup',
      tradingDayNumber,
      ipoNoLimitTradingDays: noLimitDays,
    };
  }
  return {
    lifecycle: 'normal',
    tradingDayNumber,
    ipoNoLimitTradingDays: noLimitDays,
  };
}

function normalizeCode(securityCode: string): string {
  return securityCode.replace(/\D/g, '').slice(-6);
}
