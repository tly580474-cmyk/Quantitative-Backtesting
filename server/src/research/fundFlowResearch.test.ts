import { describe, expect, it, vi } from 'vitest';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { buildFundFlowResult, queryFundFlows, validateFundFlowOptions } from './fundFlowResearch.js';
const options = { end: '2026-09-20', days: 2, top: 5, group: 'stock' as const };
const rows = (value: object[]) => value as RowDataPacket[];

describe('fund flow read-only research', () => {
  it('retains missing trading days and null amounts instead of zero-filling or backfilling', () => {
    const result = buildFundFlowResult(options, ['2026-09-17', '2026-09-18'], rows([
      { tradeDate: '2026-09-17', sampleCount: 2, mainNetInYi: 3, superLargeNetInYi: 4, largeNetInYi: -1 },
    ]), rows([{ tradeDate: '2026-09-18', expectedCount: 5 }]), [], [], 'now');
    expect(result).toMatchObject({ status: 'partial', usable: true, totalMainNetInYi: 3, missingDates: ['2026-09-18'], windowComplete: false });
    expect(result.daily[1]).toMatchObject({ mainNetInYi: null, sampleCount: 0, expectedCount: 5 });
  });
  it('preserves negative outflows, sample days, and non-historical industry semantics', () => {
    const result = buildFundFlowResult({ ...options, group: 'industry', days: 1 }, ['2026-09-18'], rows([
      { tradeDate: '2026-09-18', sampleCount: 3, mainNetInYi: -4, superLargeNetInYi: -2, largeNetInYi: -2 },
    ]), [], rows([{ industry: 'a', mainNetInYi: '1', daysCovered: 1, sampleCount: 1 },
      { industry: 'b', mainNetInYi: '-5', daysCovered: 1, sampleCount: 2 }]), [], 'now');
    expect(result.topOutflow[0].mainNetInYi).toBe(-5);
    expect(result.topInflow).toHaveLength(1);
    expect(result.classification?.basis).toBe('current_instrument_industry');
  });
  it.each([{ days: 0 }, { days: 1.5 }, { days: 61 }, { end: '2026-02-30' }, { symbol: "600000' OR 1=1" }, { top: 51 }])('rejects invalid input %j', extra => {
    expect(() => validateFundFlowOptions({ ...options, ...extra })).toThrow('INVALID_ARGUMENT');
  });
  it('uses the trading calendar, parameter binding, and a read-only transaction with cleanup on failure', async () => {
    const query = vi.fn().mockResolvedValueOnce([[]]).mockResolvedValueOnce([rows([{ tradeDate: '2026-09-18' }])])
      .mockRejectedValueOnce(new Error('query failed'));
    const connection = { query, beginTransaction: vi.fn(), rollback: vi.fn(), release: vi.fn() };
    await expect(queryFundFlows({ getConnection: async () => connection } as unknown as Pool, options)).rejects.toThrow('query failed');
    expect(query.mock.calls[0][0]).toBe('SET TRANSACTION READ ONLY');
    expect(query.mock.calls[1][1]).toEqual(['2026-09-20', 2]);
    expect(query.mock.calls[2][1]).toEqual(['2026-09-18']);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });
  it('checks a bounded explicit coverage range without requiring the default last-N length', async () => {
    const dateRows = rows([{ tradeDate: '2026-09-17' }, { tradeDate: '2026-09-18' }]);
    const query = vi.fn().mockResolvedValue([[]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([dateRows])
      .mockResolvedValueOnce([rows(dateRows.map(row => ({ ...row, sampleCount: 1, mainNetInYi: 1 })))]);
    const connection = { query, beginTransaction: vi.fn(), rollback: vi.fn(), release: vi.fn() };
    const result = await queryFundFlows({ getConnection: async () => connection } as unknown as Pool,
      { ...options, days: 5, start: '2026-09-17', end: '2026-09-18' });
    expect(query.mock.calls[1][1]).toEqual(['2026-09-18', '2026-09-17', 61]);
    expect(result).toMatchObject({ status: 'available', windowComplete: true, calendarDaysFound: 2 });
    expect(result.requested.days).toBeUndefined();
  });
});
