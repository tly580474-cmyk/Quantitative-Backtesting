import { describe, expect, it, vi } from 'vitest';
import { getMarketOpinionTradeDateStatus, publishedExchangeStatus, resolveMarketOpinionDayMode } from './marketOpinionTradingDay.js';

describe('market opinion calendar policy', () => {
  it('skips a weekday exchange holiday with the option enabled', async () => {
    const read = vi.fn().mockResolvedValue(false);
    await expect(resolveMarketOpinionDayMode(new Date('2026-10-01T04:00:00Z'), true, read)).resolves.toBe('skip');
    expect(read).toHaveBeenCalledWith('SH', '2026-10-01');
  });

  it('uses overseas and news mode for a weekday holiday when disabled', async () => {
    await expect(resolveMarketOpinionDayMode(new Date('2026-10-01T04:00:00Z'), false, async () => false)).resolves.toBe('non_trading');
  });

  it('allows normal trading-day reports with either setting', async () => {
    for (const skip of [true, false]) {
      await expect(resolveMarketOpinionDayMode(new Date('2026-09-30T04:00:00Z'), skip, async () => true)).resolves.toBe('trading');
    }
  });

  it('uses the Shanghai date across the UTC date boundary and handles weekends with either setting', async () => {
    const read = vi.fn();
    await expect(resolveMarketOpinionDayMode(new Date('2026-10-03T16:30:00Z'), true, read)).resolves.toBe('skip');
    await expect(resolveMarketOpinionDayMode(new Date('2026-10-03T16:30:00Z'), false, read)).resolves.toBe('non_trading');
    expect(read).not.toHaveBeenCalled();
  });

  it('fails closed on a missing or unavailable calendar instead of guessing an open weekday', async () => {
    const now = new Date('2026-10-01T01:00:00Z');
    await expect(resolveMarketOpinionDayMode(now, true, async () => null)).rejects.toThrow('交易日历缺失');
    await expect(resolveMarketOpinionDayMode(now, false, async () => null)).rejects.toThrow('交易日历缺失');
    await expect(resolveMarketOpinionDayMode(now, false, async () => { throw new Error('DB offline'); })).rejects.toThrow('DB offline');
  });
});

describe('missing persisted calendar dates', () => {
  it('uses the published exchange schedule before daily bars exist', async () => {
    const dependencies = { readStored: async () => null, token: '' };
    await expect(getMarketOpinionTradeDateStatus('SH', '2026-10-05', dependencies)).resolves.toBe(false);
    await expect(getMarketOpinionTradeDateStatus('SH', '2026-10-08', dependencies)).resolves.toBe(true);
    expect(publishedExchangeStatus('2026-10-10')).toBe(false);
    expect(publishedExchangeStatus('2026-02-23')).toBe(false);
    expect(publishedExchangeStatus('2026-02-24')).toBe(true);
    expect(publishedExchangeStatus('2027-01-01')).toBeNull();
  });

  it('honours an explicit persisted calendar record', async () => {
    await expect(getMarketOpinionTradeDateStatus('SH', '2026-10-08', { readStored: async () => false })).resolves.toBe(false);
  });

  it('uses Tushare for dates outside the published calendar and reads fields in provider order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0,
      data: { fields: ['is_open', 'cal_date'], items: [[0, '20270101']] } }) });
    await expect(getMarketOpinionTradeDateStatus('SH', '2027-01-01', {
      readStored: async () => null, token: 'mock-token', fetchImpl,
    })).resolves.toBe(false);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toMatchObject({ api_name: 'trade_cal', params: { exchange: 'SSE' } });
  });

  it('does not interpret an empty API response or unavailable token as an open weekday', async () => {
    await expect(getMarketOpinionTradeDateStatus('SH', '2027-01-04', { readStored: async () => null, token: '' })).resolves.toBeNull();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { fields: ['cal_date', 'is_open'], items: [] } }) });
    await expect(getMarketOpinionTradeDateStatus('SH', '2027-01-04', {
      readStored: async () => null, token: 'mock-token', fetchImpl,
    })).resolves.toBeNull();
  });
});
