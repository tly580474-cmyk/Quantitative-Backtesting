import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../config.js';
import { createPool, closePool } from '../db/connection.js';

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  try {
    const [[summary], [metrics], [missingMetricsSample], [orphanInstruments]] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS rowsCount,
                COUNT(DISTINCT instrument_key) AS instruments,
                DATE_FORMAT(MIN(trade_date), '%Y-%m-%d') AS minDate,
                DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS maxDate,
                SUM(low > LEAST(open, close)
                    OR high < GREATEST(open, close)
                    OR low > high) AS invalidOhlc
         FROM daily_bars_v2`,
      ),
      pool.query('SELECT COUNT(*) AS rowsCount FROM daily_stock_metrics'),
      pool.query(
        `SELECT COUNT(*) AS missingMetrics
         FROM (
           SELECT instrument_key, trade_date
           FROM daily_bars_v2
           LIMIT 100000
         ) AS bar
         LEFT JOIN daily_stock_metrics AS metric
           ON metric.instrument_key = bar.instrument_key
          AND metric.trade_date = bar.trade_date
         WHERE metric.instrument_key IS NULL`,
      ),
      pool.query(
        `SELECT COUNT(*) AS orphanInstruments
         FROM (
           SELECT DISTINCT instrument_key
           FROM daily_bars_v2
         ) AS bar
         LEFT JOIN instruments AS instrument
           ON instrument.instrument_key = bar.instrument_key
         WHERE instrument.instrument_key IS NULL`,
      ),
    ]);

    const singleTimings = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      const [rows] = await pool.query(
        `SELECT bar.*
         FROM daily_bars_v2 AS bar
         INNER JOIN instruments AS instrument
           ON instrument.instrument_key = bar.instrument_key
         WHERE instrument.market = 'SZ'
           AND instrument.symbol = '000001'
           AND instrument.type = 'stock'
         ORDER BY bar.trade_date`,
      );
      singleTimings.push({
        rows: Array.isArray(rows) ? rows.length : 0,
        milliseconds: round(performance.now() - started),
      });
    }

    const crossStarted = performance.now();
    const [crossRows] = await pool.query(
      `SELECT instrument_key, close, volume
       FROM daily_bars_v2
       WHERE trade_date = (SELECT MAX(trade_date) FROM daily_bars_v2)`,
    );
    const crossMilliseconds = round(performance.now() - crossStarted);

    const concurrentStarted = performance.now();
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => pool.query(
        `SELECT * FROM daily_bars_v2
         WHERE instrument_key = ?
         ORDER BY trade_date`,
        [index + 1],
      )),
    );

    console.log(JSON.stringify({
      summary: firstRow(summary),
      metrics: firstRow(metrics),
      missingMetricsSample: firstRow(missingMetricsSample),
      orphanInstruments: firstRow(orphanInstruments),
      singleStock: singleTimings,
      latestCrossSection: {
        rows: Array.isArray(crossRows) ? crossRows.length : 0,
        milliseconds: crossMilliseconds,
      },
      tenConcurrentQueriesMilliseconds: round(performance.now() - concurrentStarted),
    }, null, 2));
  } finally {
    await closePool(pool);
  }
}

function firstRow(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

main().catch((error) => {
  process.stderr.write(`历史库基准失败：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
