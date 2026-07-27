import { describe, expect, it } from 'vitest';
import {
  PAPER_TRADING_ACCOUNTING_POLICY,
  assertPaperOrderTransition,
  canTransitionPaperOrder,
  isTerminalPaperOrderStatus,
  type PaperOrderState,
} from './domain.js';
import {
  evaluateAshareTradability,
} from '../../../shared/trading-rules/index.js';

describe('paper trading domain baseline', () => {
  it('defines fixed database precision instead of binary-float ledger fields', () => {
    expect(PAPER_TRADING_ACCOUNTING_POLICY).toMatchObject({
      databaseMoneyType: 'DECIMAL(20,4)',
      databasePriceType: 'DECIMAL(20,4)',
      databaseQuantityType: 'DECIMAL(20,6)',
      stockLotSize: 100,
    });
  });

  it('allows only explicit order state transitions', () => {
    expect(canTransitionPaperOrder('created', 'validated')).toBe(true);
    expect(canTransitionPaperOrder('accepted', 'partially_filled')).toBe(true);
    expect(canTransitionPaperOrder('partially_filled', 'filled')).toBe(true);
    expect(() => assertPaperOrderTransition('created', 'filled')).toThrow(
      '非法模拟委托状态转换',
    );
    expect(() => assertPaperOrderTransition('filled', 'cancelled')).toThrow(
      '非法模拟委托状态转换',
    );
  });

  it('recognizes every terminal state', () => {
    expect(isTerminalPaperOrderStatus('filled')).toBe(true);
    expect(isTerminalPaperOrderStatus('rejected')).toBe(true);
    expect(isTerminalPaperOrderStatus('cancelled')).toBe(true);
    expect(isTerminalPaperOrderStatus('expired')).toBe(true);
    expect(isTerminalPaperOrderStatus('partially_filled')).toBe(false);
  });

  it('restores serialized pending state without losing transition semantics', () => {
    const state: PaperOrderState = {
      id: 'order-1',
      accountId: 'account-1',
      instrumentKey: 600000,
      clientOrderId: 'client-order-1',
      side: 'buy',
      orderType: 'limit',
      timeInForce: 'day',
      quantity: 100,
      limitPrice: 10,
      status: 'accepted',
      filledQuantity: 0,
      averageFillPrice: null,
      rejectCode: null,
      rejectReason: null,
      createdAt: '2026-07-27T09:30:00+08:00',
      updatedAt: '2026-07-27T09:30:00+08:00',
    };
    const restored = JSON.parse(JSON.stringify(state)) as PaperOrderState;
    expect(restored).toEqual(state);
    expect(() => assertPaperOrderTransition(restored.status, 'partially_filled')).not.toThrow();
  });

  it('keeps the shared tradability rule within the Phase 0 batch baseline', () => {
    const startedAt = performance.now();
    let tradableCount = 0;
    for (let index = 0; index < 25_000; index += 1) {
      const result = evaluateAshareTradability({
        securityCode: index % 2 === 0 ? 'SH600000' : 'SZ300001',
        securityStatus: 'active',
        marketPhase: 'continuous_trading',
        previousClose: 10,
        orderPrice: 10,
      });
      if (result.tradable) tradableCount += 1;
    }
    expect(tradableCount).toBe(25_000);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
