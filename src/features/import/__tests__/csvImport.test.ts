import { describe, expect, it } from 'vitest';
import { parseImportFile } from '../useImport';

describe('CSV import', () => {
  it('imports a UTF-8 stock CSV and preserves a leading-zero symbol', async () => {
    const csv = [
      '日期,代码,名称,开盘价,最高价,最低价,收盘价,前收盘价,成交量（股）,成交额（元）,换手率,涨幅%',
      '2026-06-30,000001,平安银行,12.10,12.50,12.00,12.40,12.10,1234567,15234567.89,1.25,2.48',
      '2026-07-01,000001,平安银行,12.40,12.60,12.20,12.30,12.40,1134567,14234567.89,1.15,-0.81',
    ].join('\n');
    const file = new File([csv], '000001.csv', { type: 'text/csv;charset=utf-8' });

    const result = await parseImportFile(file);

    expect(result.success).toBe(true);
    expect(result.totalRows).toBe(2);
    expect(result.validRows).toBe(2);
    expect(result.symbol).toBe('000001');
    expect(result.candles[0]).toMatchObject({
      time: '2026-06-30',
      symbol: '000001',
      open: 12.1,
      high: 12.5,
      low: 12,
      close: 12.4,
      volume: 1234567,
      turnover: 0.1523456789,
      turnoverRatePct: 1.25,
      changePercent: 2.48,
    });
  });
});
