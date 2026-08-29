import { describe, expect, it } from 'vitest';
import { isNaturalDayTaskDue } from './marketHealthScheduler.js';

describe('market health natural-day scheduling', () => {
  it('runs after the configured minute without consulting the trading calendar', () => {
    expect(isNaturalDayTaskDue(10 * 60 + 29, '10:30')).toBe(false);
    expect(isNaturalDayTaskDue(10 * 60 + 30, '10:30')).toBe(true);
    expect(isNaturalDayTaskDue(23 * 60, '10:30')).toBe(true);
  });

  it('rejects malformed schedule values', () => {
    expect(isNaturalDayTaskDue(600, '24:00')).toBe(false);
    expect(isNaturalDayTaskDue(600, '10:60')).toBe(false);
  });
});
