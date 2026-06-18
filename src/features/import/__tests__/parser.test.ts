import { describe, it, expect } from 'vitest';
import { parseSheetData } from '../parser';

const sampleHeader = [
  '日期Date', '指数代码Index Code', '指数中文全称Index Chinese Name(Full)',
  '指数中文简称Index Chinese Name', '指数英文全称Index English Name(Full)',
  '指数英文简称Index English Name', '开盘Open', '最高High', '最低Low',
  '收盘Close', '涨跌Change', '涨跌幅(%)Change(%)', '成交量 Volume',
  '成交金额（亿元）Turnover', '样本数量ConsNumber',
];

function makeRow(date: string, o: number, h: number, l: number, c: number) {
  return [
    date, '000852', '中证1000指数', '中证1000', 'CSI 1000 Index',
    'CSI 1000', String(o), String(h), String(l), String(c),
    String(c - o), String(((c - o) / o * 100).toFixed(2)),
    '1000000', '100', 1000,
  ];
}

describe('parseSheetData', () => {
  it('parses valid data rows', () => {
    const rows = [
      sampleHeader,
      makeRow('20210621', 100, 110, 95, 105),
      makeRow('20210622', 105, 115, 100, 110),
    ];
    const result = parseSheetData(rows);
    expect(result.errors).toHaveLength(0);
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]).toMatchObject({
      time: '2021-06-21',
      symbol: '000852',
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      change: 5,
      changePercent: 5,
    });
  });

  it('reports missing required columns', () => {
    const rows = [['日期Date', '收盘Close'], ['20210621', '100']];
    const result = parseSheetData(rows);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('缺少必填列');
  });

  it('handles empty file', () => {
    const rows: unknown[][] = [];
    const result = parseSheetData(rows);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles header-only file', () => {
    const rows = [sampleHeader];
    const result = parseSheetData(rows);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles row with invalid date', () => {
    const rows = [
      sampleHeader,
      makeRow('notadate', 100, 110, 95, 105),
    ];
    const result = parseSheetData(rows);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('handles row with non-numeric OHLC', () => {
    const rows = [
      sampleHeader,
      ['20210621', '000852', '', '', '', '', 'abc', 'def', 'ghi', 'jkl'],
    ];
    const result = parseSheetData(rows);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('stores change percent consistently in percentage points', () => {
    const numericRow = makeRow('20210621', 100, 110, 95, 105);
    const percentRow = makeRow('20210622', 105, 115, 100, 110);
    numericRow[11] = '4.76';
    percentRow[11] = '4.76%';

    const result = parseSheetData([sampleHeader, numericRow, percentRow]);
    expect(result.candles[0].changePercent).toBeCloseTo(4.76, 10);
    expect(result.candles[1].changePercent).toBeCloseTo(4.76, 10);
  });
});
