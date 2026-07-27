import { describe, expect, it } from 'vitest';
import {
  PAPER_RISK_RULES_VERSION,
  evaluatePaperRisk,
  type PaperRiskConfig,
  type RiskEvaluationContext,
} from './riskControl.js';

function baseContext(overrides: Partial<RiskEvaluationContext> = {}): RiskEvaluationContext {
  return {
    accountId: 'account-1',
    side: 'buy',
    securityCode: '600519',
    instrumentKey: 600519,
    quantity: 100,
    estimatePrice: 10,
    orderAmount: 1000,
    currentCash: 1_000_000,
    currentFrozenCash: 0,
    currentMarketValue: 0,
    currentTotalEquity: 1_000_000,
    currentInitialCash: 1_000_000,
    currentSecurityPositionValue: 0,
    todayTradeCount: 0,
    todayTurnover: 0,
    todayRealizedPnl: 0,
    peakEquity: null,
    accountStatus: 'active',
    ...overrides,
  };
}

function baseConfig(overrides: Partial<PaperRiskConfig> = {}): PaperRiskConfig {
  return {
    id: 'risk-1',
    accountId: 'account-1',
    maxSinglePositionRatio: null,
    maxTotalPositionRatio: null,
    maxOrderAmount: null,
    maxDailyTurnover: null,
    maxDailyOrders: null,
    maxDrawdownRatio: null,
    maxDailyLoss: null,
    ruleVersion: PAPER_RISK_RULES_VERSION,
    createdAt: '2026-07-27 00:00:00.000',
    updatedAt: '2026-07-27 00:00:00.000',
    ...overrides,
  };
}

describe('paper trading risk evaluation', () => {
  it('passes when no config is provided', () => {
    const result = evaluatePaperRisk(null, baseContext());
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('passes when config is empty (all limits disabled)', () => {
    const result = evaluatePaperRisk(baseConfig(), baseContext());
    expect(result.passed).toBe(true);
  });

  it('rejects when account is not active', () => {
    const result = evaluatePaperRisk(
      baseConfig(),
      baseContext({ accountStatus: 'paused' }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].ruleCode).toBe('account_inactive');
  });

  it('enforces max_order_amount for both buy and sell', () => {
    const config = baseConfig({ maxOrderAmount: 500 });
    const buy = evaluatePaperRisk(config, baseContext({ side: 'buy', orderAmount: 1000 }));
    expect(buy.passed).toBe(false);
    expect(buy.violations[0].ruleCode).toBe('max_order_amount');
    const sell = evaluatePaperRisk(
      config,
      baseContext({ side: 'sell', orderAmount: 1000 }),
    );
    expect(sell.passed).toBe(false);
    expect(sell.violations[0].ruleCode).toBe('max_order_amount');
  });

  it('enforces max_single_position_ratio only for buys', () => {
    const config = baseConfig({ maxSinglePositionRatio: 0.1 });
    const buy = evaluatePaperRisk(
      config,
      baseContext({ currentTotalEquity: 1_000_000, orderAmount: 200_000 }),
    );
    expect(buy.passed).toBe(false);
    expect(buy.violations[0].ruleCode).toBe('max_single_position_ratio');
    const sell = evaluatePaperRisk(
      config,
      baseContext({ side: 'sell', currentTotalEquity: 1_000_000, orderAmount: 200_000 }),
    );
    expect(sell.passed).toBe(true);
  });

  it('enforces max_total_position_ratio only for buys', () => {
    const config = baseConfig({ maxTotalPositionRatio: 0.5 });
    const buy = evaluatePaperRisk(
      config,
      baseContext({ currentMarketValue: 400_000, orderAmount: 200_000, currentTotalEquity: 1_000_000 }),
    );
    expect(buy.passed).toBe(false);
    expect(buy.violations[0].ruleCode).toBe('max_total_position_ratio');
  });

  it('enforces max_drawdown_ratio only for buys', () => {
    const config = baseConfig({ maxDrawdownRatio: 0.1 });
    const buy = evaluatePaperRisk(
      config,
      baseContext({ peakEquity: 1_200_000, currentTotalEquity: 1_000_000 }),
    );
    expect(buy.passed).toBe(false);
    expect(buy.violations[0].ruleCode).toBe('max_drawdown_ratio');
    const sell = evaluatePaperRisk(
      config,
      baseContext({ side: 'sell', peakEquity: 1_200_000, currentTotalEquity: 1_000_000 }),
    );
    expect(sell.passed).toBe(true);
  });

  it('enforces max_daily_loss when realized pnl hits threshold', () => {
    const config = baseConfig({ maxDailyLoss: 5000 });
    const result = evaluatePaperRisk(
      config,
      baseContext({ todayRealizedPnl: -5000 }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].ruleCode).toBe('max_daily_loss');
  });

  it('enforces max_daily_turnover for both buy and sell', () => {
    const config = baseConfig({ maxDailyTurnover: 100_000 });
    const buy = evaluatePaperRisk(
      config,
      baseContext({ todayTurnover: 95_000, orderAmount: 10_000 }),
    );
    expect(buy.passed).toBe(false);
    expect(buy.violations[0].ruleCode).toBe('max_daily_turnover');
    const sell = evaluatePaperRisk(
      config,
      baseContext({ side: 'sell', todayTurnover: 95_000, orderAmount: 10_000 }),
    );
    expect(sell.passed).toBe(false);
    expect(sell.violations[0].ruleCode).toBe('max_daily_turnover');
  });

  it('enforces max_daily_orders count including current order', () => {
    const config = baseConfig({ maxDailyOrders: 5 });
    const ok = evaluatePaperRisk(
      config,
      baseContext({ todayTradeCount: 4 }),
    );
    expect(ok.passed).toBe(true);
    const blocked = evaluatePaperRisk(
      config,
      baseContext({ todayTradeCount: 5 }),
    );
    expect(blocked.passed).toBe(false);
    expect(blocked.violations[0].ruleCode).toBe('max_daily_orders');
  });

  it('returns multiple violations at once when several limits are breached', () => {
    const config = baseConfig({
      maxOrderAmount: 500,
      maxSinglePositionRatio: 0.05,
      maxDailyOrders: 1,
    });
    // orderAmount 100_000 on a 1_000_000 equity = 10% > 5% single-position limit
    const result = evaluatePaperRisk(
      config,
      baseContext({ todayTradeCount: 1, orderAmount: 100_000 }),
    );
    expect(result.passed).toBe(false);
    const codes = result.violations.map((v) => v.ruleCode);
    expect(codes).toContain('max_order_amount');
    expect(codes).toContain('max_single_position_ratio');
    expect(codes).toContain('max_daily_orders');
  });

  it('returns passed=true for sell when only buy-side rules are configured', () => {
    const config = baseConfig({
      maxSinglePositionRatio: 0.1,
      maxTotalPositionRatio: 0.5,
      maxDrawdownRatio: 0.05,
      maxDailyLoss: 1000,
    });
    const result = evaluatePaperRisk(
      config,
      baseContext({
        side: 'sell',
        currentMarketValue: 800_000,
        currentTotalEquity: 1_000_000,
        peakEquity: 1_200_000,
        todayRealizedPnl: -2000,
        orderAmount: 100,
      }),
    );
    expect(result.passed).toBe(true);
  });

  it('passes when orderAmount equals the limit exactly (boundary)', () => {
    const config = baseConfig({ maxOrderAmount: 1_000 });
    const result = evaluatePaperRisk(
      config,
      baseContext({ orderAmount: 1_000 }),
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects max_daily_loss when realized loss equals threshold exactly', () => {
    const config = baseConfig({ maxDailyLoss: 5000 });
    // todayRealizedPnl = -5000, threshold is "less than or equal to -maxDailyLoss"
    const result = evaluatePaperRisk(
      config,
      baseContext({ todayRealizedPnl: -5000 }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].ruleCode).toBe('max_daily_loss');
  });

  it('passes max_daily_loss when loss is strictly above threshold', () => {
    const config = baseConfig({ maxDailyLoss: 5000 });
    const result = evaluatePaperRisk(
      config,
      baseContext({ todayRealizedPnl: -4999.99 }),
    );
    expect(result.passed).toBe(true);
  });

  it('passes max_daily_orders when count is exactly at limit minus one', () => {
    const config = baseConfig({ maxDailyOrders: 5 });
    const result = evaluatePaperRisk(
      config,
      baseContext({ todayTradeCount: 4 }),
    );
    expect(result.passed).toBe(true);
  });

  it('skips single-position and total-position checks when equity is zero', () => {
    const config = baseConfig({
      maxSinglePositionRatio: 0.1,
      maxTotalPositionRatio: 0.5,
    });
    const result = evaluatePaperRisk(
      config,
      baseContext({
        currentTotalEquity: 0,
        currentMarketValue: 0,
        currentSecurityPositionValue: 0,
        orderAmount: 100,
      }),
    );
    // equity <= 0 means ratioAfterBuy/totalRatioAfterBuy both return 1, exceeding 0.1 / 0.5
    expect(result.passed).toBe(false);
    const codes = result.violations.map((v) => v.ruleCode);
    expect(codes).toContain('max_single_position_ratio');
    expect(codes).toContain('max_total_position_ratio');
  });

  it('treats zero drawdown when peakEquity is null', () => {
    const config = baseConfig({ maxDrawdownRatio: 0.05 });
    const result = evaluatePaperRisk(
      config,
      baseContext({ peakEquity: null, currentTotalEquity: 900_000 }),
    );
    expect(result.passed).toBe(true);
  });

  it('includes metric snapshot in violation for debugging', () => {
    const config = baseConfig({ maxOrderAmount: 500 });
    const result = evaluatePaperRisk(
      config,
      baseContext({ orderAmount: 1_500 }),
    );
    expect(result.violations[0].metricSnapshot).toMatchObject({
      orderAmount: 1_500,
      limit: 500,
    });
  });
});
