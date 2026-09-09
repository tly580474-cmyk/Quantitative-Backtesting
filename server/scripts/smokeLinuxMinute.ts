import 'dotenv/config';
import assert from 'node:assert/strict';
import { queryMinuteBars } from '../src/minuteData/minuteDataService.js';
assert.equal(process.env.QUANT_TEST_MODE, 'true');
const result = await queryMinuteBars(process.env.MINUTE_DATA_ROOT!, {
  code: '000001', startDate: '2026-07-24', endDate: '2026-07-24', intervalMinutes: 1, limit: 100, includeZeroVolume: false,
});
assert.equal(result.items.length, 10);
assert.equal(result.sourceFiles, 1);
assert.equal(result.items[0].close, 10);
console.log('PASS minute Parquet ZIP import and DuckDB query: 10 sample bars');
