import 'dotenv/config';
import { readFile, copyFile, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { join } from 'node:path';

if (process.platform !== 'linux' || process.cwd() !== '/opt/quant-backtest/server') {
  throw new Error('Run only from /opt/quant-backtest/server on the target Linux deployment.');
}

const mode = process.argv[2];
if (mode === 'enable' || mode === 'enable-collectors' || mode === 'enable-health') {
  const path = '.env';
  let text = await readFile(path, 'utf8');
  await copyFile(path, `.env.before-data-repair-${Date.now()}`);
  const settings = mode === 'enable-health'
    ? { MARKET_HEALTH_ENABLED: 'true', MARKET_OPINION_PUSH_ENABLED: 'false' }
    : mode === 'enable-collectors'
    ? { DRAGON_TIGER_ENABLED: 'true', MARKET_NEWS_ENABLED: 'true' }
    : { MARKET_DATA_ENABLED: 'true', MARKET_INDEX_AUTO_UPDATE_ENABLED: 'true' };
  for (const [key, value] of Object.entries(settings)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text}\n${key}=${value}\n`;
  }
  await writeFile(path, text);
  console.log(`Enabled ${Object.keys(settings).join(', ')}; saved original environment backup.`);
} else if (mode === 'calendar' || mode === 'daily') {
  const endpoint = mode === 'calendar' ? 'calendars' : 'incremental';
  const body = mode === 'calendar'
    ? { market: 'SH', startDate: '2026-09-10', endDate: '2026-09-11', providerId: 'tencent' }
    : { providerId: 'tencent' };
  const response = await fetch(`http://127.0.0.1:3001/api/sync/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  console.log(response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
} else if (mode === 'audit' || mode === 'audit-collectors' || mode === 'audit-health') {
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, dateStrings: true });
  try {
    if (mode === 'audit-health') {
      console.log(JSON.stringify((await db.query("SELECT run_key, status, started_at, finished_at, error_message, details FROM market_data_collector_runs WHERE job_type IN ('market_health_nec','market_health_daily') ORDER BY started_at DESC LIMIT 4"))[0]));
    } else if (mode === 'audit-collectors') {
      for (const sql of [
        "SELECT run_key, job_type, status, started_at, finished_at, error_message, details FROM market_data_collector_runs WHERE job_type IN ('market_news','dragon_tiger') ORDER BY started_at DESC LIMIT 8",
        "SELECT trade_date, COUNT(*) AS records FROM dragon_tiger_billboards GROUP BY trade_date ORDER BY trade_date DESC LIMIT 2",
        "SELECT COUNT(*) AS records, MAX(published_at) AS latest_published_at, MAX(fetched_at) AS latest_fetched_at FROM market_news",
      ]) console.log(JSON.stringify((await db.query(sql))[0]));
      const { evaluateMarketCollectorHealth, readMarketCollectorState } = await import('../src/research/dataHealthGate.ts');
      console.log(JSON.stringify(evaluateMarketCollectorHealth(await readMarketCollectorState(db))));
      process.exitCode = 0;
    } else {
    for (const sql of [
      "SELECT DATE_FORMAT(trade_date, '%Y-%m-%d') AS trade_date, is_final, COUNT(*) AS rows_count, COUNT(DISTINCT instrument_key) AS instruments FROM daily_bars_v2 WHERE trade_date >= '2026-09-09' GROUP BY trade_date, is_final",
      "SELECT DATE_FORMAT(trade_date, '%Y-%m-%d') AS trade_date, COUNT(*) AS rows_count FROM stock_fund_flows WHERE trade_date = '2026-09-11' GROUP BY trade_date",
      "SELECT market, trade_date, is_open FROM trading_calendar WHERE trade_date BETWEEN '2026-09-10' AND '2026-09-11'",
    ]) console.log(JSON.stringify((await db.query(sql))[0]));
    }
  } finally { await db.end(); }
  if (mode === 'audit-collectors' || mode === 'audit-health') process.exit(0);
  const root = process.env.RESEARCH_SNAPSHOT_ROOT;
  if (root) {
    const pointer = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(root, pointer.snapshotId, 'manifest.json'), 'utf8'));
    console.log(JSON.stringify({ snapshot: pointer, maxDate: manifest.maxDate, rowCount: manifest.rowCount }));
  }
  const minuteRoot = process.env.MINUTE_DATA_ROOT;
  if (minuteRoot) {
    const manifest = JSON.parse(await readFile(join(minuteRoot, 'manifest.json'), 'utf8'));
    console.log(JSON.stringify({ minuteFiles: manifest.files.filter(item => item.date >= '2026-09-10') }));
  }
} else throw new Error('Use enable, calendar, daily or audit');
