import { describe, expect, it } from 'vitest';
import {
  RECONCILIATION_TOLERANCE,
  formatReconciliationResult,
  reconcilePaperAccountState,
  type AccountReconciliationData,
} from './reconciliation.js';

function balancedAccount(): AccountReconciliationData {
  return {
    account: {
      id: 'account-1',
      name: 'balanced',
      cashBalance: 1_000_000,
      frozenCash: 1_005,
    },
    ledger: {
      balanceDeltaSum: 1_000_000,
      latestFrozenAfter: 1_005,
    },
    positions: [
      {
        instrumentKey: 600519,
        securityCode: '600519',
        securityName: '贵州茅台',
        totalQuantity: 100,
        availableQuantity: 0,
        frozenQuantity: 0,
      },
    ],
    lotSums: [
      { instrumentKey: 600519, quantitySum: 100, availableSum: 0 },
    ],
  };
}

describe('paper trading reconciliation', () => {
  it('passes when ledger sum, frozen state and lot sums all match', () => {
    const result = reconcilePaperAccountState(balancedAccount());
    expect(result.ok).toBe(true);
    expect(result.cash.ok).toBe(true);
    expect(result.frozen.ok).toBe(true);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].ok).toBe(true);
  });

  it('flags cash ledger drift beyond tolerance', () => {
    const data = balancedAccount();
    data.ledger.balanceDeltaSum = 1_000_000 - 1; // 1 yuan gap
    const result = reconcilePaperAccountState(data);
    expect(result.ok).toBe(false);
    expect(result.cash.ok).toBe(false);
    // actual(1_000_000) - expected(999_999) = 1
    expect(result.cash.diff).toBe(1);
  });

  it('tolerates DECIMAL rounding within RECONCILIATION_TOLERANCE', () => {
    const data = balancedAccount();
    data.ledger.balanceDeltaSum = 1_000_000 + RECONCILIATION_TOLERANCE / 2;
    const result = reconcilePaperAccountState(data);
    expect(result.cash.ok).toBe(true);
  });

  it('flags frozen_after drift when no ledger row exists', () => {
    const data = balancedAccount();
    data.ledger.latestFrozenAfter = null;
    data.account.frozenCash = 100;
    const result = reconcilePaperAccountState(data);
    expect(result.frozen.ok).toBe(false);
    expect(result.frozen.expected).toBe(0);
    expect(result.frozen.actual).toBe(100);
  });

  it('flags position total drift when lots sum is less than total_quantity', () => {
    const data = balancedAccount();
    data.lotSums[0].quantitySum = 90;
    const result = reconcilePaperAccountState(data);
    expect(result.ok).toBe(false);
    expect(result.positions[0].totalQuantity.ok).toBe(false);
    // actual(100) - expected(90) = 10
    expect(result.positions[0].totalQuantity.diff).toBe(10);
  });

  it('flags available drift when lots available + position frozen mismatch', () => {
    const data = balancedAccount();
    data.positions[0].availableQuantity = 50;
    data.positions[0].frozenQuantity = 50;
    data.lotSums[0].availableSum = 60;
    const result = reconcilePaperAccountState(data);
    expect(result.positions[0].available.ok).toBe(false);
    // expected = 60, actual = available + frozen = 100 → diff = 40
    expect(result.positions[0].available.diff).toBe(40);
  });

  it('handles positions without any lot rows as zero sum', () => {
    const data = balancedAccount();
    data.lotSums = [];
    const result = reconcilePaperAccountState(data);
    expect(result.ok).toBe(false);
    expect(result.positions[0].ok).toBe(false);
  });

  it('passes for empty account with zero balance and no positions', () => {
    const data: AccountReconciliationData = {
      account: { id: 'empty', name: 'empty', cashBalance: 0, frozenCash: 0 },
      ledger: { balanceDeltaSum: 0, latestFrozenAfter: null },
      positions: [],
      lotSums: [],
    };
    const result = reconcilePaperAccountState(data);
    expect(result.ok).toBe(true);
    expect(result.frozen.expected).toBe(0);
    expect(result.frozen.actual).toBe(0);
  });

  it('reconciles multiple positions against grouped lot sums', () => {
    const data: AccountReconciliationData = {
      account: { id: 'multi', name: 'multi', cashBalance: 500_000, frozenCash: 0 },
      ledger: { balanceDeltaSum: 500_000, latestFrozenAfter: 0 },
      positions: [
        {
          instrumentKey: 600519,
          securityCode: '600519',
          securityName: '贵州茅台',
          totalQuantity: 100,
          availableQuantity: 100,
          frozenQuantity: 0,
        },
        {
          instrumentKey: 601318,
          securityCode: '601318',
          securityName: '中国平安',
          totalQuantity: 200,
          availableQuantity: 150,
          frozenQuantity: 50,
        },
      ],
      lotSums: [
        { instrumentKey: 600519, quantitySum: 100, availableSum: 100 },
        { instrumentKey: 601318, quantitySum: 200, availableSum: 200 },
      ],
    };
    const result = reconcilePaperAccountState(data);
    expect(result.ok).toBe(true);
    expect(result.positions).toHaveLength(2);
    // 601318 has frozen 50 + available 150 = 200, matching lotSum.availableSum
    expect(result.positions[1].available.ok).toBe(true);
  });

  it('flags mismatch on second position while first stays ok', () => {
    const data: AccountReconciliationData = {
      account: { id: 'multi', name: 'multi', cashBalance: 500_000, frozenCash: 0 },
      ledger: { balanceDeltaSum: 500_000, latestFrozenAfter: 0 },
      positions: [
        {
          instrumentKey: 600519,
          securityCode: '600519',
          securityName: '贵州茅台',
          totalQuantity: 100,
          availableQuantity: 100,
          frozenQuantity: 0,
        },
        {
          instrumentKey: 601318,
          securityCode: '601318',
          securityName: '中国平安',
          totalQuantity: 250,
          availableQuantity: 80,
          frozenQuantity: 100,
        },
      ],
      lotSums: [
        { instrumentKey: 600519, quantitySum: 100, availableSum: 100 },
        { instrumentKey: 601318, quantitySum: 200, availableSum: 200 },
      ],
    };
    const result = reconcilePaperAccountState(data);
    expect(result.ok).toBe(false);
    expect(result.positions[0].ok).toBe(true);
    expect(result.positions[1].ok).toBe(false);
    expect(result.positions[1].totalQuantity.ok).toBe(false);
    // available (80) + frozen (100) = 180 vs lot available_sum 200
    expect(result.positions[1].available.ok).toBe(false);
  });
});

describe('formatReconciliationResult', () => {
  it('produces human-readable lines for a balanced account', () => {
    const data: AccountReconciliationData = {
      account: { id: 'a-1', name: 'balanced', cashBalance: 1_000_000, frozenCash: 0 },
      ledger: { balanceDeltaSum: 1_000_000, latestFrozenAfter: 0 },
      positions: [
        {
          instrumentKey: 600519,
          securityCode: '600519',
          securityName: '贵州茅台',
          totalQuantity: 100,
          availableQuantity: 100,
          frozenQuantity: 0,
        },
      ],
      lotSums: [{ instrumentKey: 600519, quantitySum: 100, availableSum: 100 }],
    };
    const lines = formatReconciliationResult(reconcilePaperAccountState(data));
    expect(lines[0]).toContain('account=balanced(a-1)');
    expect(lines[0]).toContain('ok=true');
    expect(lines.find((line) => line.includes('cash'))).toBeDefined();
    expect(lines.find((line) => line.includes('frozen'))).toBeDefined();
    expect(lines.find((line) => line.includes('600519'))).toBeDefined();
  });

  it('includes diff values when account is unbalanced', () => {
    const data: AccountReconciliationData = {
      account: { id: 'a-2', name: 'drift', cashBalance: 999_000, frozenCash: 0 },
      ledger: { balanceDeltaSum: 1_000_000, latestFrozenAfter: 0 },
      positions: [],
      lotSums: [],
    };
    const lines = formatReconciliationResult(reconcilePaperAccountState(data));
    const cashLine = lines.find((line) => line.includes('cash'));
    expect(cashLine).toBeDefined();
    expect(cashLine).toContain('ok=false');
    expect(cashLine).toContain('diff=');
  });

  it('uses 0/0 for empty positions list', () => {
    const data: AccountReconciliationData = {
      account: { id: 'a-3', name: 'empty', cashBalance: 0, frozenCash: 0 },
      ledger: { balanceDeltaSum: 0, latestFrozenAfter: null },
      positions: [],
      lotSums: [],
    };
    const lines = formatReconciliationResult(reconcilePaperAccountState(data));
    expect(lines[0]).toContain('ok=true');
    expect(lines.filter((line) => line.includes('position'))).toHaveLength(0);
  });

  it('respects tolerance when rounding DECIMAL drift', () => {
    const data: AccountReconciliationData = {
      account: {
        id: 'a-4',
        name: 'tolerance',
        cashBalance: 1_000_000 + RECONCILIATION_TOLERANCE,
        frozenCash: 0,
      },
      ledger: { balanceDeltaSum: 1_000_000, latestFrozenAfter: 0 },
      positions: [],
      lotSums: [],
    };
    const result = reconcilePaperAccountState(data);
    expect(result.cash.ok).toBe(true);
    const lines = formatReconciliationResult(result);
    expect(lines[1]).toContain('ok=true');
  });
});
