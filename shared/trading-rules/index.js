/**
 * Platform-neutral trading rules shared by browser backtests and the server.
 * Keep this module free of UI, database and Node-specific dependencies.
 */

export const TRADING_RULES_VERSION = 'cn-equity-trading-rules-2026.1';
export const PRICE_LIMIT_RULES_VERSION = 'cn-equity-price-limit-2026.1';

export const TRADING_PRECISION = Object.freeze({
  priceDecimals: 4,
  moneyDecimals: 4,
  quantityDecimals: 6,
  stockLotSize: 100,
  priceTick: 0.01,
});

const MAINBOARD_REGISTRATION_FIRST_LISTING = '2023-04-10';
const CHINEXT_REGISTRATION_FIRST_LISTING = '2020-08-24';
const STAR_FIRST_LISTING = '2019-07-22';

export function roundDecimal(value, decimals) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function roundMoney(value) {
  return roundDecimal(value, TRADING_PRECISION.moneyDecimals);
}

export function roundPrice(value) {
  return roundDecimal(value, TRADING_PRECISION.priceDecimals);
}

export function applySlippage(price, side, slippageBps) {
  if (!Number.isFinite(price) || price <= 0) return Number.NaN;
  if (!Number.isFinite(slippageBps) || slippageBps < 0) return Number.NaN;
  const factor = slippageBps / 10000;
  return price * (side === 'buy' ? 1 + factor : 1 - factor);
}

export function calculateCommission(amount, commissionRate, minimumCommission) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return roundMoney(Math.max(amount * commissionRate, minimumCommission));
}

export function calculateSellTax(amount, sellTaxRate) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return roundMoney(amount * sellTaxRate);
}

export function normalizeStockBuyQuantity(
  requestedQuantity,
  lotSize = TRADING_PRECISION.stockLotSize,
) {
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) return 0;
  return Math.floor(requestedQuantity / lotSize) * lotSize;
}

export function normalizeStockSellQuantity(
  requestedQuantity,
  positionQuantity,
  lotSize = TRADING_PRECISION.stockLotSize,
) {
  if (
    !Number.isFinite(requestedQuantity)
    || !Number.isFinite(positionQuantity)
    || requestedQuantity <= 0
    || positionQuantity <= 0
  ) return 0;
  const capped = Math.min(requestedQuantity, positionQuantity);
  return capped >= positionQuantity
    ? positionQuantity
    : Math.floor(capped / lotSize) * lotSize;
}

export function normalizeSecurityCode(securityCode) {
  return String(securityCode ?? '').replace(/\D/g, '').slice(-6);
}

export function inferAshareBoard(securityCode) {
  const code = normalizeSecurityCode(securityCode);
  if (/^(4|8|920)/.test(code)) return 'bse';
  if (/^(300|301)/.test(code)) return 'chinext';
  if (/^(688|689)/.test(code)) return 'star';
  return 'main';
}

export function ipoNoLimitTradingDays(board, listDate) {
  if (!listDate) return 0;
  if (board === 'bse') return 1;
  if (board === 'star') return listDate >= STAR_FIRST_LISTING ? 5 : 0;
  if (board === 'chinext') {
    return listDate >= CHINEXT_REGISTRATION_FIRST_LISTING ? 5 : 0;
  }
  return listDate >= MAINBOARD_REGISTRATION_FIRST_LISTING ? 5 : 0;
}

export function normalPriceLimitRatio(board, isRiskWarning = false) {
  if (board === 'bse') return 0.30;
  if (board === 'chinext' || board === 'star') return 0.20;
  return isRiskWarning ? 0.05 : 0.10;
}

export function resolvePriceLimitRule(input) {
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
    ruleVersion: PRICE_LIMIT_RULES_VERSION,
  };
}

export function resolveListingLifecycle(input) {
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

export function calculatePriceLimitPrices(previousClose, rule) {
  if (
    rule.limitRatio == null
    || !Number.isFinite(previousClose)
    || previousClose <= 0
  ) {
    return { limitUp: null, limitDown: null };
  }
  return {
    limitUp: roundDecimal(
      previousClose * (1 + rule.limitRatio),
      decimalsFromTick(TRADING_PRECISION.priceTick),
    ),
    limitDown: roundDecimal(
      previousClose * (1 - rule.limitRatio),
      decimalsFromTick(TRADING_PRECISION.priceTick),
    ),
  };
}

export function evaluateAshareTradability(input) {
  const priceLimitRule = resolvePriceLimitRule(input);
  const limits = calculatePriceLimitPrices(input.previousClose, priceLimitRule);
  const base = {
    priceLimitRule,
    ...limits,
    ruleVersion: TRADING_RULES_VERSION,
  };

  if (input.securityStatus !== 'active') {
    const reasons = {
      pending: ['security_pending', '证券尚未上市'],
      suspended: ['security_suspended', '证券处于停牌状态'],
      delisted: ['security_delisted', '证券已退市'],
    };
    const [reasonCode, reason] = reasons[input.securityStatus]
      ?? ['security_unavailable', '证券状态不可交易'];
    return { tradable: false, reasonCode, reason, ...base };
  }

  const tradingPhases = new Set([
    'opening_auction',
    'continuous_trading',
    'closing_auction',
  ]);
  if (!tradingPhases.has(input.marketPhase)) {
    return {
      tradable: false,
      reasonCode: 'market_closed',
      reason: '当前不在可撮合交易时段',
      ...base,
    };
  }

  if (
    input.orderPrice != null
    && priceLimitRule.limitRatio != null
    && (limits.limitUp == null || limits.limitDown == null)
  ) {
    return {
      tradable: false,
      reasonCode: 'missing_reference_price',
      reason: '缺少有效昨收价，无法校验委托价格范围',
      ...base,
    };
  }

  if (input.orderPrice != null && limits.limitUp != null && input.orderPrice > limits.limitUp) {
    return {
      tradable: false,
      reasonCode: 'price_above_limit',
      reason: '委托价格高于涨停价',
      ...base,
    };
  }

  if (input.orderPrice != null && limits.limitDown != null && input.orderPrice < limits.limitDown) {
    return {
      tradable: false,
      reasonCode: 'price_below_limit',
      reason: '委托价格低于跌停价',
      ...base,
    };
  }

  return {
    tradable: true,
    reasonCode: null,
    reason: null,
    ...base,
  };
}

function decimalsFromTick(tick) {
  const text = String(tick);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}
