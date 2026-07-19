import { describe, expect, it } from 'vitest';
import { dueDigestKinds } from './marketOpinionPushScheduler.js';

const schedule = {
  times: { morning: '09:00', midday: '12:00', close: '16:00' },
  graceMinutes: 20,
  weekdaysOnly: true,
} as const;

describe('market opinion push scheduler', () => {
  it('selects each Shanghai-time slot only inside its grace window', () => {
    expect(dueDigestKinds(new Date('2026-07-20T01:05:00Z'), schedule)).toEqual(['morning']);
    expect(dueDigestKinds(new Date('2026-07-20T04:15:00Z'), schedule)).toEqual(['midday']);
    expect(dueDigestKinds(new Date('2026-07-20T08:20:00Z'), schedule)).toEqual(['close']);
    expect(dueDigestKinds(new Date('2026-07-20T08:21:00Z'), schedule)).toEqual([]);
  });

  it('does not send weekday reports on weekends', () => {
    expect(dueDigestKinds(new Date('2026-07-19T01:05:00Z'), schedule)).toEqual([]);
  });
});
