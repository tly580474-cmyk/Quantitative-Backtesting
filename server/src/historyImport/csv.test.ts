import { describe, expect, it } from 'vitest';
import {
  HISTORY_COLUMNS,
  assertHistoryHeader,
  inferInstrumentStatus,
  inferMarket,
  isValidOhlc,
  normalizeHistoryRecord,
  parseCsvLine,
  parseHistoryRecord,
} from './csv.js';

function row(overrides: Record<string, string> = {}) {
  const values = Object.fromEntries(HISTORY_COLUMNS.map((column) => [column, '']));
  Object.assign(values, {
    日期: '2026-07-03',
    代码: '000001',
    名称: '平安银行',
    开盘价: '12.1',
    最高价: '12.5',
    最低价: '12',
    收盘价: '12.4',
    '成交量（股）': '10000',
    是否ST: '否',
    是否涨停: '否',
  }, overrides);
  return HISTORY_COLUMNS.map((column) => values[column]).join(',');
}

describe('history CSV normalization', () => {
  it('parses quoted commas and escaped quotes', () => {
    expect(parseCsvLine('a,\"b,c\",\"d\"\"e\"')).toEqual(['a', 'b,c', 'd"e']);
  });

  it('validates the canonical header and normalizes one row', () => {
    expect(() => assertHistoryHeader(`\ufeff${HISTORY_COLUMNS.join(',')}`)).not.toThrow();
    const normalized = normalizeHistoryRecord(parseHistoryRecord(row({
      所属行业: '银行',
      退市时间: '-',
      '滚动市盈率': '5.2',
    })));
    expect(normalized).toMatchObject({
      tradeDate: '2026-07-03',
      code: '000001',
      industry: '银行',
      peTtm: 5.2,
      delistDate: null,
    });
  });

  it('rejects invalid OHLC relationships', () => {
    expect(() => normalizeHistoryRecord(parseHistoryRecord(row({
      最高价: '11',
    })))).toThrow(/OHLC/);
  });

  it('can preserve invalid source OHLC for quality quarantine', () => {
    const normalized = normalizeHistoryRecord(parseHistoryRecord(row({
      最高价: '11',
    })), { allowInvalidOhlc: true });
    expect(isValidOhlc(normalized)).toBe(false);
  });

  it('maps markets and delisted status', () => {
    expect(inferMarket('600000')).toBe('SH');
    expect(inferMarket('000001')).toBe('SZ');
    expect(inferMarket('920992')).toBe('BJ');
    expect(inferInstrumentStatus('长药退', null)).toBe('delisted');
    expect(inferInstrumentStatus('测试股票', '2026-06-01', '2026-07-04')).toBe('delisted');
  });
});
