import { describe, expect, it } from 'vitest';
import { resolveIndexTargetDate } from './indexDatasetUpdater.js';

describe('resolveIndexTargetDate', () => {
  it('uses the previous business day while the China market is open', () => {
    expect(resolveIndexTargetDate('cn-index', new Date('2026-07-02T06:30:00Z')))
      .toBe('2026-07-01');
  });

  it('allows the current China business day once the market has closed', () => {
    expect(resolveIndexTargetDate('cn-index', new Date('2026-07-02T07:00:00Z')))
      .toBe('2026-07-02');
  });

  it('rolls a Monday China intraday update back to Friday', () => {
    expect(resolveIndexTargetDate('cn-index', new Date('2026-07-06T06:30:00Z')))
      .toBe('2026-07-03');
  });

  it('uses the previous business day while Nasdaq is open', () => {
    expect(resolveIndexTargetDate('us-index', new Date('2026-07-02T19:59:00Z')))
      .toBe('2026-07-01');
  });

  it('allows the current New York business day once Nasdaq has closed', () => {
    expect(resolveIndexTargetDate('us-index', new Date('2026-07-02T20:00:00Z')))
      .toBe('2026-07-02');
  });

  it('handles the New York winter UTC offset', () => {
    expect(resolveIndexTargetDate('us-index', new Date('2026-01-02T21:00:00Z')))
      .toBe('2026-01-02');
  });

  it('rolls weekend updates back to Friday', () => {
    expect(resolveIndexTargetDate('cn-index', new Date('2026-07-05T08:00:00Z')))
      .toBe('2026-07-03');
    expect(resolveIndexTargetDate('us-index', new Date('2026-07-05T20:00:00Z')))
      .toBe('2026-07-03');
  });
});
