import { describe, expect, it } from 'vitest';
import { isScheduledTimeDue } from './indexDatasetScheduler.js';
import { isScheduledCloseDue } from './syncScheduler.js';

describe('market data scheduler time handling', () => {
  it('runs the closing update at or after the configured Shanghai time', () => {
    expect(isScheduledCloseDue(15 * 60 + 9, '15:10')).toBe(false);
    expect(isScheduledCloseDue(15 * 60 + 10, '15:10')).toBe(true);
    expect(isScheduledCloseDue(18 * 60, '15:10')).toBe(true);
  });

  it('rejects malformed closing times', () => {
    expect(isScheduledCloseDue(18 * 60, '25:10')).toBe(false);
    expect(isScheduledCloseDue(18 * 60, '15:99')).toBe(false);
    expect(isScheduledCloseDue(18 * 60, 'invalid')).toBe(false);
  });

  it('lets index updates catch up after a service restart', () => {
    expect(isScheduledTimeDue('15:09', '15:10')).toBe(false);
    expect(isScheduledTimeDue('15:10', '15:10')).toBe(true);
    expect(isScheduledTimeDue('16:30', '15:10')).toBe(true);
    expect(isScheduledTimeDue('25:00', '15:10')).toBe(false);
  });
});
