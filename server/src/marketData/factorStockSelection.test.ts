import { describe, expect, it } from 'vitest';
import { assembleHistory } from './factorStockSelection.js';
import type { RawSelectionRow } from './factorStockSelection.js';

const factorKeys = [
  'roe', 'grossMargin', 'ocfToRevenue', 'fcfToEv', 'debtToAssets',
  'receivablesTurnover', 'inventoryTurnover', 'logMarketCap', 'logRevenue',
  'logAssets', 'turnover', 'turnover20', 'turnoverStd20',
] as const;

describe('factor stock selection history', () => {
  it('keeps today plus five prior sessions and computes return from selection close', () => {
    const dates = [
      '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27',
      '2026-07-28', '2026-07-29', '2026-07-30',
    ];
    const rows: RawSelectionRow[] = dates.flatMap((tradeDate, dateIndex) => Array.from({ length: 24 }, (_, index) => ({
      instrumentKey: `stock-${index}`,
      market: index % 2 ? 'SZ' : 'SH',
      symbol: String(index).padStart(6, '0'),
      name: `股票${index}`,
      industry: `行业${index % 4}`,
      tradeDate,
      close: 10 + index + dateIndex,
      latestPrice: 10 + index + dates.length - 1,
      financialAsOf: '2026-04-30',
      values: Object.fromEntries(factorKeys.map((key, factorIndex) => [
        key,
        Math.sin((index + 1) * (factorIndex + 2)) * 10 + index * (factorIndex % 3),
      ])) as RawSelectionRow['values'],
    })));

    const result = assembleHistory(rows, {
      snapshotId: 'snapshot-1',
      snapshotCreatedAt: '2026-07-30T09:00:00Z',
      dataAsOf: '2026-07-30',
      selectionSize: 10,
    });

    expect(result.batches).toHaveLength(6);
    expect(result.batches[0].tradeDate).toBe('2026-07-30');
    expect(result.batches[0].items).toHaveLength(10);
    expect(result.batches[0].items.every((item) => item.returnSinceSelectionPct === 0)).toBe(true);
    expect(result.batches.at(-1)?.tradeDate).toBe('2026-07-23');
    expect(result.batches.at(-1)?.items.some((item) => item.returnSinceSelectionPct > 0)).toBe(true);
  });
});
