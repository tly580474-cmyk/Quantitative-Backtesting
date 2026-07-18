import { describe, expect, it } from 'vitest';
import { isCollectorTimeDue } from './dragonTigerScheduler.js';
import { newsSlotKey } from './marketNewsScheduler.js';

describe('market collectors scheduling', () => {
  it('supports catch-up after the configured Shanghai time', () => {
    expect(isCollectorTimeDue(17 * 60 + 59, '18:00')).toBe(false);
    expect(isCollectorTimeDue(18 * 60, '18:00')).toBe(true);
    expect(isCollectorTimeDue(20 * 60, '18:00')).toBe(true);
    expect(isCollectorTimeDue(20 * 60, '25:00')).toBe(false);
  });

  it('builds stable Shanghai news slots', () => {
    expect(newsSlotKey(new Date('2026-07-18T01:31:00.000Z'), 3)).toBe('2026-07-18:0930');
    expect(newsSlotKey(new Date('2026-07-18T01:32:59.000Z'), 3)).toBe('2026-07-18:0930');
  });
});
