import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { createPool } from '../../db/connection.js';
import { loadConfig } from '../../config.js';
import type { CompressedFactor } from '../../historyImport/factor.js';
import { auditAdjustmentContinuity, type AuditBar } from './adjustmentAudit.js';

interface AuditInstrument extends RowDataPacket {
  instrument_key: number; id: string; symbol: string; name: string; market: string;
  status: string; list_date: string | null; factor_version: string | null; last_checked_date: string | null;
}

async function main() {
  const [start, end, output] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '') || start > end || !output) {
    throw new Error('Usage: adjustmentAuditCli.ts YYYY-MM-DD YYYY-MM-DD output-directory');
  }
  const root = resolve(output); await mkdir(root, { recursive: true });
  const pool = createPool(loadConfig());
  try {
    const [instruments] = await pool.query<AuditInstrument[]>(`SELECT i.instrument_key,i.id,i.symbol,i.name,i.market,i.status,
      i.list_date,p.factor_version,DATE_FORMAT(p.last_checked_date,'%Y-%m-%d') last_checked_date
      FROM instruments i LEFT JOIN adjustment_factor_publications p ON p.instrument_key=i.instrument_key
      WHERE i.type='stock' ORDER BY i.symbol`);
    const [factors] = await pool.query<RowDataPacket[]>(`SELECT f.instrument_key,
      DATE_FORMAT(f.effective_date,'%Y-%m-%d') effectiveDate,f.factor,f.price_offset AS offset
      FROM adjustment_factors_v2 f JOIN adjustment_factor_publications p
      ON p.instrument_key=f.instrument_key AND p.factor_version=f.factor_version ORDER BY f.instrument_key,f.effective_date`);
    const byKey = new Map<number, CompressedFactor[]>();
    for (const f of factors) {
      const list = byKey.get(f.instrument_key) ?? [];
      list.push({ effectiveDate: f.effectiveDate, factor: f.factor, offset: f.offset }); byKey.set(f.instrument_key, list);
    }
    const results = [];
    let barsChecked = 0; let compared = 0; let mismatchDays = 0; let withBars = 0;
    for (const i of instruments) {
      const columns = `DATE_FORMAT(trade_date,'%Y-%m-%d') tradeDate,open,high,low,close,previous_close previousClose,source_key sourceKey`;
      const [rows] = await pool.query<(RowDataPacket & AuditBar)[]>(`(SELECT ${columns} FROM daily_bars_v2
        WHERE instrument_key=? AND is_final=1 AND trade_date BETWEEN ? AND ?)
        UNION ALL (SELECT ${columns} FROM daily_bars_v2 WHERE instrument_key=? AND is_final=1 AND trade_date<?
        ORDER BY trade_date DESC LIMIT 1) ORDER BY tradeDate`, [i.instrument_key, start, end, i.instrument_key, start]);
      const count = rows.filter(r => r.tradeDate >= start).length;
      if (!count) { results.push({ ...i, instrumentStatus: i.status, status: 'no_bars_in_window', bars: 0 }); continue; }
      const result = auditAdjustmentContinuity(rows, byKey.get(i.instrument_key) ?? [], start);
      const status = result.structural.length || result.mismatches.length ? 'needs_reference'
        : result.missingPreviousClose.length ? 'incomplete_reference' : 'consistent';
      results.push({ ...i, instrumentStatus: i.status, status, bars: count, ...result });
      barsChecked += count; compared += result.compared; mismatchDays += result.mismatches.length; withBars++;
      if (withBars % 500 === 0) console.log(JSON.stringify({ scanned: withBars, barsChecked, mismatchDays }));
    }
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const summary = { start, end, checkedAt: new Date().toISOString(), instruments: instruments.length,
      withBars, barsChecked, compared, mismatchDays, counts, root };
    await writeFile(resolve(root, 'audit.json'), JSON.stringify({ summary, results }, null, 2));
    console.log(JSON.stringify(summary));
    console.log(JSON.stringify({ largest: results.filter(r => 'maxDifference' in r)
      .sort((a, b) => ('maxDifference' in b ? b.maxDifference : 0) - ('maxDifference' in a ? a.maxDifference : 0))
      .slice(0, 12).map(r => ({ symbol: r.symbol, name: r.name, status: r.status,
        maxDifference: 'maxDifference' in r ? r.maxDifference : 0 })) }));
  } finally { await pool.end(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
