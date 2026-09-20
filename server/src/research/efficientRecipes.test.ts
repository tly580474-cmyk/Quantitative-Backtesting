import { it, expect } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { efficientRecipeSql, peDca } from './efficientRecipes.js';
it('ranks before future availability and measures fourteen calendar trading days with adjusted prices', async () => {
  const db = await DuckDBInstance.create(':memory:');
  const con = await db.connect();
  try {
    await con.run(`CREATE TABLE trading_calendar AS SELECT DATE '2026-01-01'+CAST(i AS INTEGER) tradeDate FROM range(50) t(i);
      CREATE TABLE bars AS SELECT 1 instrumentKey,'600001' symbol,'测试' AS name,'SH' market,tradeDate,100000001 amount,
        100.0 AS open,100.0 AS close FROM trading_calendar;
      CREATE TABLE adjustment_factors AS SELECT 1 instrumentKey,DATE '2026-01-01' effectiveDate,1.0 factor,0.0 priceOffset,
        TIMESTAMP '2026-01-01' publishedAt,'v1' factorVersion;
      UPDATE bars SET close=50,open=50 WHERE tradeDate >= DATE '2026-01-25';
      INSERT INTO adjustment_factors VALUES(1,DATE '2026-01-25',2,0,TIMESTAMP '2026-01-25','v1');`);
    const recipe = efficientRecipeSql('factor-layer-14', new Map([['--start','2026-01-21'],['--end','2026-02-19']]));
    const sql = recipe.sql.replaceAll('$start', "DATE '2026-01-21'").replaceAll('$end', "DATE '2026-02-19'")
      .replaceAll('$amount','100000000').replaceAll('$top','20');
    const rows = (await con.runAndReadAll(sql)).getRowObjectsJson() as Array<Record<string, unknown>>;
    expect(Number(rows[0].signals)).toBe(30);
    expect(Number(rows[0].samples)).toBe(16);
    expect(Number(rows[0].missingExits)).toBe(14);
    expect(rows[0].averageReturn).toBe(0); // Raw prices would produce a false -50% return.
  } finally { con.closeSync(); db.closeSync(); }
});
it('PE decisions exclude execution-day and future PE, reject proxies and preserve missing data', () => {
  const input = { source: {name:'fixture',instrument:'test-index',valuationType:'official-index-pe',priceBasis:'official-price-index',availability:'point-in-time'},
    tradingDates:['2026-01-29','2026-01-30','2026-02-02','2026-02-03'],
    rows:[{date:'2026-01-29',pe:10,close:100},{date:'2026-01-30',pe:20,close:100},{date:'2026-02-02',pe:1,close:100},{date:'2026-02-03',pe:100,close:110}] };
  const result = peDca(input,2);
  expect(result.series[0]).toMatchObject({percentile:1,contribution:500,signalDate:'2026-01-30'});
  expect(result.profit).toBe(50);
  expect(peDca({...input,rows:input.rows.map((r,i)=>i===2?{...r,pe:999}:r)},2).series).toEqual(result.series);
  expect(() => peDca({...input,source:{...input.source,valuationType:'stock-pe-proxy'}},2)).toThrow('DATA_UNAVAILABLE');
  expect(peDca({...input,rows:input.rows.map((r,i)=>i===0?{...r,pe:null}:r)},2).missedSignals).toBe(1);
});
