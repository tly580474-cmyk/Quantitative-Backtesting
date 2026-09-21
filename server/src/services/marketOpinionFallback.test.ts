import { describe, expect, it, vi } from 'vitest';
import { parseOpinionCapitalFlow, parseSinaSectorRows, withFreshFallback } from './marketOpinionFallback.js';

describe('mail market data fallbacks', () => {
  const afterClose = new Date('2026-09-21T12:00:00Z');

  it('uses the requested trading day and does not invent stock coverage', () => {
    const result = parseOpinionCapitalFlow(['2026-09-21,8637833216'], '2026-09-21', true, afterClose);
    expect(result.mainNetInYi).toBe(86.38);
    expect(result.sampleCount).toBeNull();
    expect(result.coveragePct).toBeNull();
    expect(result.source).toContain('非逐股覆盖统计');
    expect(() => parseOpinionCapitalFlow(['2026-09-18,12'], '2026-09-21', true, afterClose)).toThrow('没有');
    expect(() => parseOpinionCapitalFlow(['2026-09-21,'], '2026-09-21', true, afterClose)).toThrow('没有');
  });

  it('rejects daily rows during trading and stale or future minute rows', () => {
    const now = new Date('2026-09-21T02:00:00Z');
    expect(() => parseOpinionCapitalFlow(['2026-09-21,10'], '2026-09-21', true, now)).toThrow('盘中');
    expect(() => parseOpinionCapitalFlow(['2026-09-21 09:35,10'], '2026-09-21', false, now)).toThrow('过期');
    expect(() => parseOpinionCapitalFlow(['2026-09-21 10:30,10'], '2026-09-21', false, now)).toThrow('时间戳');
    expect(parseOpinionCapitalFlow(['2026-09-21 09:59,10'], '2026-09-21', false, now).stale).toBe(false);
  });

  it('accepts the actual morning close during lunch, but not earlier intraday rows', () => {
    const noon = new Date('2026-09-21T04:00:00Z');
    expect(parseOpinionCapitalFlow(['2026-09-21 11:30,10'], '2026-09-21', false, noon).tradeDate).toBe('2026-09-21');
    expect(() => parseOpinionCapitalFlow(['2026-09-21 11:29,10'], '2026-09-21', false, noon)).toThrow('过期');
  });

  it('parses JSON assignments without turning missing sector funds into zero', () => {
    const rows = parseSinaSectorRows('var data = {"new_a":"new_a,行业A,12,10,1,2.5,200,300000000,sh600001,3,10,1,示例股"};', 'industry');
    expect(rows[0]).toMatchObject({ name: '行业A', changePct: 2.5, amountYi: 3, mainNetInYi: null, advancers: null });
    expect(parseSinaSectorRows('{"a":"a,A,1,1,1,-,1,1"}', 'concept')).toEqual([]);
    expect(() => parseSinaSectorRows('var x = {"a": (()=>123)()}', 'industry')).toThrow();
  });

  it('preserves healthy and valid reference snapshots, but rejects failed alternatives', async () => {
    const alternate = vi.fn(async () => ({ stale: false, value: 2 }));
    const current = { stale: false, value: 1 };
    expect(await withFreshFallback(Promise.resolve(current), alternate)).toBe(current);
    const reference = { stale: true, value: 1 };
    expect(await withFreshFallback(Promise.resolve(reference), alternate, () => true)).toBe(reference);
    expect(alternate).not.toHaveBeenCalled();
    expect(await withFreshFallback(Promise.resolve(reference), alternate)).toEqual({ stale: false, value: 2 });
    await expect(withFreshFallback(Promise.reject(new Error('primary failed')), async () => { throw new Error('backup failed'); })).rejects.toThrow('backup failed');
  });
});
