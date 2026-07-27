/**
 * Compatibility entry point for market-data callers. The implementation lives
 * in the platform-neutral shared module so browser scoring, backtests and the
 * server-side paper trader use the same versioned rules.
 */
export {
  calculatePriceLimitPrices,
  evaluateAshareTradability,
  inferAshareBoard,
  ipoNoLimitTradingDays,
  normalPriceLimitRatio,
  resolveListingLifecycle,
  resolvePriceLimitRule,
} from '../../../shared/trading-rules/index.js';

export type {
  AshareBoard,
  ChinaMarketPhase,
  ListingLifecycle,
  ListingLifecycleInput,
  ListingLifecycleResult,
  PriceLimitRule,
  PriceLimitRuleInput,
  SecurityTradingStatus,
  TradabilityInput,
  TradabilityResult,
} from '../../../shared/trading-rules/index.js';
