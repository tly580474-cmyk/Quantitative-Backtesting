import 'dotenv/config';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

if (process.env.QUANT_TEST_MODE !== 'true' || process.env.DB_NAME !== 'quant_backtest_linux_test'
  || !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST)) throw new Error('Seed is restricted to the local Linux test database');
const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
try {
  const dates = [];
  for (let i = 0; dates.length < 60; i++) {
    const date = new Date(Date.UTC(2026, 4, 4 + i));
    if (![0, 6].includes(date.getUTCDay())) dates.push(date.toISOString().slice(0, 10));
  }
  for (const [index, symbol] of ['000001', '600000', '000002'].entries()) {
    const now = new Date().toISOString();
    await db.execute(`INSERT INTO instruments (id, market, symbol, name, type, list_date, status, created_at, updated_at)
      VALUES (?, 'CN', ?, ?, 'stock', '2000-01-01', 'active', ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name)`,
    [randomUUID(), symbol, `LINUX_TEST_SYNTHETIC_${symbol}`, now, now]);
    const [[inst]] = await db.execute('SELECT instrument_key FROM instruments WHERE market=? AND symbol=? AND type=?', ['CN', symbol, 'stock']);
    for (const [i, date] of dates.entries()) {
      const close = 10 + index * 5 + i * 0.03 + Math.sin(i) * 0.1;
      await db.execute(`INSERT INTO daily_bars_v2
        (instrument_key,trade_date,open,high,low,close,previous_close,volume,amount,turnover_rate_pct,source_version,fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(3)) ON DUPLICATE KEY UPDATE close=VALUES(close)`,
      [inst.instrument_key, date, close - 0.02, close + 0.1, close - 0.1, close, close - 0.03, 100000 + i * 100, close * (100000 + i * 100), 1.2, 'linux-synthetic']);
      await db.execute(`INSERT INTO daily_stock_metrics (instrument_key,trade_date,total_shares,float_shares,total_market_cap,float_market_cap,pe_ttm,pb)
        VALUES (?,?,100000000,80000000,?,?,12,1.2) ON DUPLICATE KEY UPDATE pe_ttm=VALUES(pe_ttm)`,
      [inst.instrument_key, date, close * 100000000, close * 80000000]);
    }
  }
  const [[counts]] = await db.query('SELECT (SELECT COUNT(*) FROM instruments) instruments, (SELECT COUNT(*) FROM daily_bars_v2) daily_bars');
  console.log(JSON.stringify({ synthetic: true, ...counts }));
} finally { await db.end(); }
