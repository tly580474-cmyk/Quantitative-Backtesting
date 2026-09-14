import { describe, expect, it } from 'vitest';
import { buildDailyIntradayPath } from './DailyIntradayModal';

describe('buildDailyIntradayPath', () => {
  it('requests one exact trading day at one-minute resolution', () => {
    const path = buildDailyIntradayPath('600000', '2026-09-08');
    expect(path).toContain('/stocks/600000/minute?');
    const query = new URLSearchParams(path.split('?')[1]);
    expect(Object.fromEntries(query)).toMatchObject({
      startDate: '2026-09-08',
      endDate: '2026-09-08',
      interval: '1',
      includeZeroVolume: 'true',
      limit: '1000',
    });
  });

  it('encodes the symbol as a path segment', () => {
    expect(buildDailyIntradayPath('SH/000001', '2026-09-08')).toContain('/stocks/SH%2F000001/minute?');
  });
});
