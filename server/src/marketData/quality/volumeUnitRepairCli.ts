import 'dotenv/config';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { loadConfig } from '../../config.js';
import { closePool, createPool } from '../../db/connection.js';

type Direction = 'divide-by-100' | 'multiply-by-100';

interface CandidateSummaryRow extends RowDataPacket {
  direction: Direction;
  rowsCount: number;
  instrumentsCount: number;
  firstDate: string | Date | null;
  lastDate: string | Date | null;
}

interface RepairSummary {
  dailyBarsV2: CandidateSummaryRow[];
  dailyCandles: CandidateSummaryRow[];
}

const DIVIDE_PREDICATE = `
  volume >= 100
  AND amount IS NOT NULL
  AND amount > 0
  AND amount / volume < low * 0.5
  AND amount / (volume / 100) BETWEEN low * 0.5 AND high * 2
`;

const MULTIPLY_PREDICATE = `
  volume > 0
  AND amount IS NOT NULL
  AND amount > 0
  AND amount / volume > high * 2
  AND amount / (volume * 100) BETWEEN low * 0.5 AND high * 2
`;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const pool = createPool(loadConfig());
  try {
    const before = await summarizeAll(pool);
    let changedRows = 0;
    if (apply) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [divideResult] = await connection.query<ResultSetHeader>(`
          UPDATE daily_bars_v2
          SET volume = ROUND(volume / 100),
              source_version = CASE
                WHEN source_version LIKE '%:vol/%' OR source_version LIKE '%:vol*%'
                  THEN source_version
                ELSE LEFT(CONCAT(source_version, ':vol/100'), 64)
              END
          WHERE ${DIVIDE_PREDICATE}
        `);
        const [multiplyResult] = await connection.query<ResultSetHeader>(`
          UPDATE daily_bars_v2
          SET volume = volume * 100,
              source_version = CASE
                WHEN source_version LIKE '%:vol/%' OR source_version LIKE '%:vol*%'
                  THEN source_version
                ELSE LEFT(CONCAT(source_version, ':vol*100'), 64)
              END
          WHERE ${MULTIPLY_PREDICATE}
        `);
        const [legacyDivideResult] = await connection.query<ResultSetHeader>(`
          UPDATE daily_candles
          SET volume = ROUND(volume / 100),
              source_version = CASE
                WHEN source_version LIKE '%:vol/%' OR source_version LIKE '%:vol*%'
                  THEN source_version
                ELSE LEFT(CONCAT(source_version, ':vol/100'), 32)
              END
          WHERE ${legacyPredicate(DIVIDE_PREDICATE)}
        `);
        const [legacyMultiplyResult] = await connection.query<ResultSetHeader>(`
          UPDATE daily_candles
          SET volume = volume * 100,
              source_version = CASE
                WHEN source_version LIKE '%:vol/%' OR source_version LIKE '%:vol*%'
                  THEN source_version
                ELSE LEFT(CONCAT(source_version, ':vol*100'), 32)
              END
          WHERE ${legacyPredicate(MULTIPLY_PREDICATE)}
        `);
        changedRows = divideResult.affectedRows
          + multiplyResult.affectedRows
          + legacyDivideResult.affectedRows
          + legacyMultiplyResult.affectedRows;
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
    const after = apply ? await summarizeAll(pool) : before;
    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      canonicalUnit: 'shares',
      before,
      changedRows,
      after,
    }, null, 2));
  } finally {
    await closePool(pool);
  }
}

async function summarizeAll(
  pool: ReturnType<typeof createPool>,
): Promise<RepairSummary> {
  const [dailyBars, legacy] = await Promise.all([
    summarize(pool),
    summarizeLegacy(pool),
  ]);
  return { dailyBarsV2: dailyBars, dailyCandles: legacy };
}

async function summarize(
  pool: ReturnType<typeof createPool>,
): Promise<CandidateSummaryRow[]> {
  const [rows] = await pool.query<CandidateSummaryRow[]>(`
    SELECT direction,
           COUNT(*) AS rowsCount,
           COUNT(DISTINCT instrument_key) AS instrumentsCount,
           MIN(trade_date) AS firstDate,
           MAX(trade_date) AS lastDate
    FROM (
      SELECT instrument_key, trade_date, 'divide-by-100' AS direction
      FROM daily_bars_v2
      WHERE ${DIVIDE_PREDICATE}
      UNION ALL
      SELECT instrument_key, trade_date, 'multiply-by-100' AS direction
      FROM daily_bars_v2
      WHERE ${MULTIPLY_PREDICATE}
    ) candidates
    GROUP BY direction
    ORDER BY direction
  `);
  return mapSummaryRows(rows);
}

async function summarizeLegacy(
  pool: ReturnType<typeof createPool>,
): Promise<CandidateSummaryRow[]> {
  const [rows] = await pool.query<CandidateSummaryRow[]>(`
    SELECT direction,
           COUNT(*) AS rowsCount,
           COUNT(DISTINCT instrument_id) AS instrumentsCount,
           MIN(trade_date) AS firstDate,
           MAX(trade_date) AS lastDate
    FROM (
      SELECT instrument_id, trade_date, 'divide-by-100' AS direction
      FROM daily_candles
      WHERE ${legacyPredicate(DIVIDE_PREDICATE)}
      UNION ALL
      SELECT instrument_id, trade_date, 'multiply-by-100' AS direction
      FROM daily_candles
      WHERE ${legacyPredicate(MULTIPLY_PREDICATE)}
    ) candidates
    GROUP BY direction
    ORDER BY direction
  `);
  return mapSummaryRows(rows);
}

function mapSummaryRows(rows: CandidateSummaryRow[]): CandidateSummaryRow[] {
  return rows.map((row) => ({
    direction: row.direction,
    rowsCount: Number(row.rowsCount),
    instrumentsCount: Number(row.instrumentsCount),
    firstDate: dateOnly(row.firstDate),
    lastDate: dateOnly(row.lastDate),
  })) as CandidateSummaryRow[];
}

function legacyPredicate(predicate: string): string {
  return predicate.replaceAll('amount', 'turnover');
}

function dateOnly(value: string | Date | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
