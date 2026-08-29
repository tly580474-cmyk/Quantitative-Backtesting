import { describe, expect, it } from 'vitest';
import { isFinancialUpdateDue } from './financialDataScheduler.js';

describe('financialDataScheduler', () => {
  it('becomes due at and after the configured Shanghai minute without a trading-calendar gate', () => {
    expect(isFinancialUpdateDue(18 * 60 + 59, '19:00')).toBe(false);
    expect(isFinancialUpdateDue(19 * 60, '19:00')).toBe(true);
    expect(isFinancialUpdateDue(20 * 60, '19:00')).toBe(true);
  });

  it('rejects malformed schedule values', () => {
    expect(isFinancialUpdateDue(0, '25:00')).toBe(false);
    expect(isFinancialUpdateDue(0, 'noon')).toBe(false);
  });
});
