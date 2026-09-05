import { describe, expect, it } from 'vitest';
import {
  assembleCsi1000LowPbHistory,
  type RawCsi1000LowPbRow,
} from './csi1000LowPbSelection.js';

function row(rebalanceDate: string, symbol: string, pb: number): RawCsi1000LowPbRow {
  return {
    constituentSnapshotId: `snapshot-${rebalanceDate}`,
    constituentDate: rebalanceDate,
    rebalanceDate,
    instrumentKey: symbol,
    market: symbol.startsWith('6') ? 'SH' : 'SZ',
    symbol,
    name: `股票${symbol}`,
    industry: '测试行业',
    pb,
    totalMarketCap: 12_000_000_000,
    selectedPrice: 10,
    latestPrice: 11,
  };
}

describe('CSI 1000 low-PB stock selection', () => {
  it('keeps six month ends, ranks ascending PB, and assigns equal weights', () => {
    const dates = ['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30', '2026-05-29', '2026-06-30', '2026-07-31'];
    const rows = dates.flatMap((date) => [
      row(date, '600001', 1.5),
      row(date, '000002', 0.8),
      row(date, '300003', 1.1),
    ]);
    const result = assembleCsi1000LowPbHistory(rows, {
      snapshotId: 'research-snapshot',
      snapshotCreatedAt: '2026-08-01T00:00:00Z',
      dataAsOf: '2026-08-05',
      selectionSize: 2,
    });

    expect(result.batches).toHaveLength(6);
    expect(result.batches[0].rebalanceDate).toBe('2026-07-31');
    expect(result.batches.at(-1)?.rebalanceDate).toBe('2026-02-27');
    expect(result.batches[0].items.map((item) => item.code)).toEqual(['000002', '300003']);
    expect(result.batches[0].items.every((item) => item.portfolioWeightPct === 50)).toBe(true);
    expect(result.batches[0].averageReturnPct).toBeCloseTo(10);
    expect(result.batches[0].positiveCount).toBe(2);
  });
});
