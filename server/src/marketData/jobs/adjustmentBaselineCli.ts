import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { loadConfig } from '../../config.js';
import { createPool } from '../../db/connection.js';
import type { PriceRow } from '../../historyImport/factor.js';
import { TencentMarketDataProvider } from '../providers/tencentProvider.js';
import { buildAdjustmentBaseline } from './adjustmentBaseline.js';

interface Target extends RowDataPacket { instrument_key: number; symbol: string; name: string; market: string }
interface RawRow extends RowDataPacket, PriceRow {}
const rawSql = `SELECT DATE_FORMAT(trade_date,'%Y-%m-%d') AS tradeDate, open,high,low,close
  FROM daily_bars_v2 WHERE instrument_key=? ORDER BY trade_date`;

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: adjustmentBaselineCli.ts [--apply]');
  const apply = args.includes('--apply');
  const pool = createPool(loadConfig());
  const lock = await pool.getConnection();
  const reportRoot = resolve('.cache/adjustment-baseline', `${Date.now()}-${randomUUID()}`);
  const results: Record<string, unknown>[] = [];
  try {
    const [locks] = await lock.query<RowDataPacket[]>("SELECT GET_LOCK('adjustment-baseline',0) AS acquired");
    if (Number(locks[0].acquired) !== 1) throw new Error('Another baseline run holds the lock');
    await mkdir(reportRoot, { recursive: true });
    const [targets] = await pool.query<Target[]>(`SELECT i.instrument_key,i.symbol,i.name,i.market
      FROM instruments i LEFT JOIN adjustment_factor_publications p ON p.instrument_key=i.instrument_key
      WHERE i.type='stock' AND i.status='active' AND p.instrument_key IS NULL ORDER BY i.symbol`);
    const provider = new TencentMarketDataProvider();
    console.log(JSON.stringify({ apply, targets: targets.length, reportRoot }));
    for (const target of targets) {
      try {
        const [raw] = await pool.query<RawRow[]>(rawSql, [target.instrument_key]);
        if (!raw.length) throw new Error('No raw history');
        const reference = await provider.fetchDailyCandles({ symbols: [`${target.symbol}.${target.market}`],
          startDate: raw[0].tradeDate, endDate: raw.at(-1)!.tradeDate, adjustment: 'qfq' });
        const qfq = reference.map(row => ({ tradeDate: row.date, open: row.open,
          high: row.high, low: row.low, close: row.close }));
        const derived = buildAdjustmentBaseline(raw, qfq);
        const evidence = { target, provider: provider.id, raw, qfq, derived };
        const fingerprint = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
        const version = `base-${fingerprint.slice(0, 20)}`;
        const batch = randomUUID();
        await writeFile(resolve(reportRoot, `${target.symbol}.json`), JSON.stringify({
          ...evidence, fingerprint, version, batch,
        }, null, 2));
        if (apply) {
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            // Serialize two initializers and refuse to replace any existing publication/factors.
            await conn.query('SELECT instrument_key FROM instruments WHERE instrument_key=? FOR UPDATE', [target.instrument_key]);
            const [existing] = await conn.query<RowDataPacket[]>(
              'SELECT instrument_key FROM adjustment_factor_publications WHERE instrument_key=? FOR UPDATE', [target.instrument_key]);
            const [factors] = await conn.query<RowDataPacket[]>(
              'SELECT instrument_key FROM adjustment_factors_v2 WHERE instrument_key=? FOR UPDATE', [target.instrument_key]);
            if (existing.length || factors.length) throw new Error('Existing publication/factors require separate review');
            const [currentRaw] = await conn.query<RawRow[]>(`${rawSql} FOR UPDATE`, [target.instrument_key]);
            if (JSON.stringify(currentRaw) !== JSON.stringify(raw)) throw new Error('Raw prices changed during validation; retry');
            await conn.execute(`INSERT INTO data_import_batches
              (id,source_root,source_snapshot,status,total_files,completed_files,failed_files,total_rows,imported_rows,started_at,finished_at,published_at)
              VALUES (?,?,?,'completed',1,1,0,?,?,NOW(3),NOW(3),NOW(3))`,
            [batch, 'provider:tencent:baseline', fingerprint, derived.factors.length, derived.factors.length]);
            for (const factor of derived.factors) {
              await conn.execute(`INSERT INTO adjustment_factors_v2
                (instrument_key,effective_date,factor_version,factor,price_offset,source_key,source_batch_id)
                VALUES (?,?,?,?,?,2,?)`, [target.instrument_key, factor.effectiveDate, version, factor.factor, factor.offset, batch]);
            }
            await conn.execute(`INSERT INTO adjustment_factor_publications
              (instrument_key,factor_version,source_batch_id,source_fingerprint,last_checked_date,published_at)
              VALUES (?,?,?,?,?,NOW(3))`, [target.instrument_key, version, batch, fingerprint, raw.at(-1)!.tradeDate]);
            await conn.commit();
          } catch (error) { await conn.rollback(); throw error; }
          finally { conn.release(); }
        }
        results.push({ symbol: target.symbol, status: apply ? 'published' : 'validated',
          rawRows: raw.length, factors: derived.factors.length, validation: derived.qfqStats, version, batch });
      } catch (error) {
        results.push({ symbol: target.symbol, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
      console.log(JSON.stringify(results.at(-1)));
      await writeFile(resolve(reportRoot, 'report.json'), JSON.stringify({ apply, results }, null, 2));
    }
    const failed = results.filter(row => row.status === 'failed').length;
    console.log(JSON.stringify({ total: targets.length, succeeded: results.length - failed, failed, reportRoot }));
    if (failed) process.exitCode = 1;
  } finally {
    await lock.query("SELECT RELEASE_LOCK('adjustment-baseline')");
    lock.release();
    await pool.end();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
