import { describe, expect, it } from 'vitest';
import {
  evaluateAshareTradability,
  resolveListingLifecycle,
  resolvePriceLimitRule,
} from './priceLimitRules';

describe('A-share price-limit rules', () => {
  it('does not classify the first five registration-regime main-board days as limit-up', () => {
    expect(resolvePriceLimitRule({
      securityCode: 'SH603293',
      listDate: '2026-07-20',
      tradeDate: '2026-07-24',
      tradingDayNumber: 5,
    })).toMatchObject({
      board: 'main',
      stage: 'ipo_no_limit',
      limitRatio: null,
    });
    expect(resolvePriceLimitRule({
      securityCode: 'SH603293',
      listDate: '2026-07-20',
      tradeDate: '2026-07-27',
      tradingDayNumber: 6,
    })).toMatchObject({
      stage: 'normal_limit',
      limitRatio: 0.10,
      detectionThreshold: 0.095,
    });
  });

  it('uses one no-limit day and then 30% for BSE', () => {
    expect(resolvePriceLimitRule({
      securityCode: 'BJ920176',
      listDate: '2026-07-24',
      tradingDayNumber: 1,
    }).limitRatio).toBeNull();
    expect(resolvePriceLimitRule({
      securityCode: 'BJ920176',
      listDate: '2026-07-24',
      tradingDayNumber: 2,
    }).limitRatio).toBe(0.30);
  });

  it('marks short-history securities as score warmup', () => {
    expect(resolveListingLifecycle({
      securityCode: 'SH688825',
      listDate: '2026-07-27',
      asOf: '2026-08-10',
      validTradingDays: 11,
      scoreWarmupDays: 65,
    })).toMatchObject({
      lifecycle: 'score_warmup',
      tradingDayNumber: 11,
      ipoNoLimitTradingDays: 5,
    });
  });

  it('rejects suspended securities and orders outside the daily price range', () => {
    expect(evaluateAshareTradability({
      securityCode: 'SH600000',
      securityStatus: 'suspended',
      marketPhase: 'continuous_trading',
      previousClose: 10,
    })).toMatchObject({
      tradable: false,
      reasonCode: 'security_suspended',
    });

    expect(evaluateAshareTradability({
      securityCode: 'SH600000',
      securityStatus: 'active',
      marketPhase: 'continuous_trading',
      previousClose: 10,
      orderPrice: 11.01,
    })).toMatchObject({
      tradable: false,
      reasonCode: 'price_above_limit',
      limitUp: 11,
      limitDown: 9,
    });
  });

  it('allows registration-regime IPO orders without normal daily price limits', () => {
    expect(evaluateAshareTradability({
      securityCode: 'SZ001234',
      listDate: '2026-07-27',
      tradingDayNumber: 1,
      securityStatus: 'active',
      marketPhase: 'continuous_trading',
      previousClose: 10,
      orderPrice: 15,
    })).toMatchObject({
      tradable: true,
      limitUp: null,
      limitDown: null,
      priceLimitRule: { stage: 'ipo_no_limit' },
    });
  });
});
