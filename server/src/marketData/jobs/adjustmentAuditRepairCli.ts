import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { createPool } from '../../db/connection.js';
import { loadConfig } from '../../config.js';
import { validateReconstruction, type CompressedFactor, type PriceRow } from '../../historyImport/factor.js';
import { buildAdjustmentBaseline } from './adjustmentBaseline.js';
import { buildAdjustmentRefreshPlan } from './adjustmentRefresh.js';
import { buildEventValidatedPlan } from './adjustmentEventPlan.js';

async function main() {
  const [directory, symbol] = process.argv.slice(2);
  if (!directory) throw new Error('Usage: adjustmentAuditRepairCli.ts audit-directory [symbol]');
  const root = resolve(directory); await mkdir(resolve(root, 'repairs'), { recursive: true });
  const pool = createPool(loadConfig());
  const connection = await pool.getConnection();
  let repaired = 0; let skipped = 0; let failed = 0;
  try {
    const [lock] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('adjustment-audit-repair',0) acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('Another audit repair is running');
    const files = (await readdir(resolve(root, 'symbols'))).filter(f => f.endsWith('.json') && (!symbol || f.startsWith(`${symbol}.`))).sort();
    for (const file of files) {
      const evidence = JSON.parse(await readFile(resolve(root, 'symbols', file), 'utf8'));
      const eventBased = evidence.result?.status === 'event_repairable';
      if (evidence.result?.status !== 'repairable' && !eventBased) { skipped++; continue; }
      const { target, raw, factors, publication, start, end } = evidence;
      const eventPlan = eventBased ? buildEventValidatedPlan({ start, end, raw: evidence.auditBars,
        factors, events: evidence.events, sina: evidence.sina }) : null;
      const qfq = eventPlan?.formulaQfq ?? evidence.qfq;
      const plan = eventPlan ?? buildAdjustmentRefreshPlan(factors, raw, qfq);
      if (!eventBased) buildAdjustmentBaseline(raw, qfq);
      if (!plan.changed || plan.validation.maxAbsoluteError > 0.025 || (!eventBased && evidence.result.rawMismatchCount !== 0)) {
        throw new Error(`Unvalidated repair plan: ${file}`);
      }
      const fingerprint = createHash('sha256').update(JSON.stringify({ target, raw, qfq, oldVersion: publication.factor_version, plan })).digest('hex');
      const version = `audit-${fingerprint.slice(0, 20)}`;
      const batch = randomUUID();
      try {
        await connection.beginTransaction();
        const [current] = await connection.query<RowDataPacket[]>(
          'SELECT * FROM adjustment_factor_publications WHERE instrument_key=? FOR UPDATE', [target.instrument_key]);
        if (current[0]?.factor_version === version) { await connection.rollback(); skipped++; continue; }
        if (current[0]?.factor_version !== publication.factor_version || current[0]?.source_fingerprint !== publication.source_fingerprint) {
          throw new Error('Publication changed after audit; re-audit required');
        }
        const [currentRaw] = await connection.query<(RowDataPacket & PriceRow)[]>(`SELECT
          DATE_FORMAT(trade_date,'%Y-%m-%d') tradeDate,open,high,low,close FROM daily_bars_v2
          WHERE instrument_key=? AND is_final=1 AND trade_date BETWEEN ? AND ? ORDER BY trade_date FOR UPDATE`,
        [target.instrument_key, start, end]);
        if (JSON.stringify(currentRaw) !== JSON.stringify(raw)) throw new Error('Raw data changed after audit');
        if (eventBased) {
          const [auditBars] = await connection.query<RowDataPacket[]>(`SELECT DATE_FORMAT(trade_date,'%Y-%m-%d') tradeDate,
            open,high,low,close,previous_close previousClose,source_key sourceKey FROM daily_bars_v2
            WHERE instrument_key=? AND is_final=1 AND trade_date BETWEEN ? AND ? ORDER BY trade_date FOR UPDATE`,
          [target.instrument_key, evidence.auditBars[0].tradeDate, end]);
          if (JSON.stringify(auditBars) !== JSON.stringify(evidence.auditBars)) throw new Error('Event reference bars changed after audit');
        }
        const [overrides] = await connection.query<RowDataPacket[]>(
          "SELECT * FROM adjusted_bar_overrides WHERE instrument_key=? AND adjustment_mode='qfq' FOR UPDATE", [target.instrument_key]);
        const backup = { target, beforePublication: current[0], beforeFactors: factors, beforeOverrides: overrides,
          afterVersion: version, batch, fingerprint, priorTransform: plan.priorTransform, checkedAt: new Date().toISOString() };
        await writeFile(resolve(root, 'repairs', `${file}.backup.json`), JSON.stringify(backup, null, 2));
        await connection.execute(`INSERT INTO data_import_batches
          (id,source_root,source_snapshot,status,total_files,completed_files,failed_files,total_rows,imported_rows,started_at,finished_at,published_at)
          VALUES (?,?,?,'completed',1,1,0,?,?,NOW(3),NOW(3),NOW(3))`,
        [batch, `provider:${evidence.source ?? 'tencent'}:six-month-audit`, fingerprint, plan.factors.length, plan.factors.length]);
        for (const f of plan.factors) await connection.execute(`INSERT INTO adjustment_factors_v2
          (instrument_key,effective_date,factor_version,factor,price_offset,source_key,source_batch_id)
          VALUES (?,?,?,?,?,?,?)`, [target.instrument_key, f.effectiveDate, version, f.factor, f.offset,
          eventBased || evidence.source === 'eastmoney' ? 2999 : 2, batch]);
        const t = plan.priorTransform;
        await connection.execute(`UPDATE adjusted_bar_overrides SET open=open*?+?,high=high*?+?,low=low*?+?,close=close*?+?,source_batch_id=?
          WHERE instrument_key=? AND adjustment_mode='qfq'`, [t.factor,t.offset,t.factor,t.offset,t.factor,t.offset,t.factor,t.offset,batch,target.instrument_key]);
        await connection.execute(`UPDATE adjustment_factor_publications SET factor_version=?,source_batch_id=?,source_fingerprint=?,
          last_checked_date=?,published_at=NOW(3) WHERE instrument_key=?`, [version,batch,fingerprint,end,target.instrument_key]);
        const [stored] = await connection.query<(RowDataPacket & CompressedFactor)[]>(`SELECT
          DATE_FORMAT(effective_date,'%Y-%m-%d') effectiveDate,factor,price_offset AS offset
          FROM adjustment_factors_v2 WHERE instrument_key=? AND factor_version=? ORDER BY effective_date`, [target.instrument_key,version]);
        const verified = validateReconstruction(currentRaw, qfq, stored, 'qfq');
        if (verified.withinTickRatio < 0.995 || verified.maxAbsoluteError > 0.025) throw new Error('Database readback validation failed');
        await connection.commit();
        repaired++;
        const result = { symbol: target.symbol, status: 'repaired', version, batch, verified,
          method: eventPlan?.validationMethod ?? 'observed_raw_and_qfq_reference' };
        await writeFile(resolve(root, 'repairs', `${file}.result.json`), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
      } catch (error) {
        await connection.rollback(); failed++;
        console.log(JSON.stringify({ symbol: target.symbol, status: 'failed', error: String(error) }));
      }
    }
    console.log(JSON.stringify({ repaired, skipped, failed }));
    if (failed) process.exitCode = 1;
  } finally {
    await connection.query("SELECT RELEASE_LOCK('adjustment-audit-repair')"); connection.release(); await pool.end();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
