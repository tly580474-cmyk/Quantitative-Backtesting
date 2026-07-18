import 'dotenv/config';
import type { RowDataPacket } from 'mysql2';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import {
  decideScheduledResearchUpdate,
  shanghaiDate,
} from './scheduledResearchGuard.js';

interface CalendarRow extends RowDataPacket {
  isOpen: number;
}

interface LatestBarRow extends RowDataPacket {
  latestDate: string | null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dateArgIndex = process.argv.indexOf('--date');
  const date = dateArgIndex >= 0 ? process.argv[dateArgIndex + 1] : shanghaiDate();
  if (!date) throw new Error('--date 缺少日期值');

  const weekendDecision = decideScheduledResearchUpdate({
    date,
    calendarStatuses: [],
    latestDailyBarDate: null,
  });
  if (weekendDecision.reason === 'weekend') {
    console.log(JSON.stringify(weekendDecision));
    return;
  }

  const pool = createPool(config);
  try {
    const [[calendarRows], [latestRows]] = await Promise.all([
      pool.query<CalendarRow[]>(`
        SELECT is_open AS isOpen
        FROM trading_calendar
        WHERE trade_date=? AND market IN ('CN', 'SH', 'SZ', 'BJ')
      `, [date]),
      pool.query<LatestBarRow[]>(`
        SELECT DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS latestDate
        FROM daily_bars_v2
      `),
    ]);
    const decision = decideScheduledResearchUpdate({
      date,
      calendarStatuses: calendarRows.map((row) => row.isOpen === 1),
      latestDailyBarDate: latestRows[0]?.latestDate ?? null,
    });
    console.log(JSON.stringify(decision));
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
