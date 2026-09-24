import 'dotenv/config';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { createPool } from '../../db/connection.js';
import { loadConfig } from '../../config.js';
import { validateReconstruction, type CompressedFactor, type PriceRow } from '../../historyImport/factor.js';

async function main() {
  const root = resolve(process.argv[2]);
  const audit = JSON.parse(await readFile(resolve(root, 'after-events', 'audit.json'), 'utf8'));
  const repaired = new Map<string, Record<string, unknown>[]>();
  for (const directory of ['reference', 'event-plans-batch1', 'event-plans-complete']) {
    const path = resolve(root, directory, 'repairs');
    for (const file of await readdir(path)) {
      if (!file.endsWith('.result.json')) continue;
      const result = JSON.parse(await readFile(resolve(path, file), 'utf8'));
      const list = repaired.get(result.symbol) ?? []; list.push({ ...result, evidenceDirectory: directory });
      repaired.set(result.symbol, list);
    }
  }
  const observed = new Map<string, Record<string, unknown>>();
  const pool = createPool(loadConfig());
  try {
    for (const directory of ['reference', 'eastmoney']) {
      const path = resolve(root, directory, 'symbols');
      for (const file of await readdir(path)) {
        const evidence = JSON.parse(await readFile(resolve(path, file), 'utf8'));
        if (!evidence.qfq?.length) continue;
        const target = evidence.target;
        const [raw] = await pool.query<(RowDataPacket & PriceRow)[]>(`SELECT DATE_FORMAT(trade_date,'%Y-%m-%d') tradeDate,
          open,high,low,close FROM daily_bars_v2 WHERE instrument_key=? AND is_final=1 AND trade_date BETWEEN ? AND ? ORDER BY trade_date`,
        [target.instrument_key, evidence.start, evidence.end]);
        const dates = new Set(evidence.qfq.map((r: PriceRow) => r.tradeDate));
        if (raw.length !== dates.size || raw.some(r => !dates.has(r.tradeDate))) continue;
        const [factors] = await pool.query<(RowDataPacket & CompressedFactor)[]>(`SELECT DATE_FORMAT(f.effective_date,'%Y-%m-%d') effectiveDate,
          f.factor,f.price_offset AS offset FROM adjustment_factors_v2 f JOIN adjustment_factor_publications p
          ON f.instrument_key=p.instrument_key AND f.factor_version=p.factor_version WHERE f.instrument_key=? ORDER BY f.effective_date`,
        [target.instrument_key]);
        const validation = validateReconstruction(raw, evidence.qfq, factors, 'qfq');
        const key = `${target.symbol}.${target.market}`;
        const pass = validation.withinTickRatio >= 0.995 && validation.maxAbsoluteError <= 0.025;
        if (!pass || !observed.has(key)) observed.set(key, { pass, source: evidence.source ?? 'tencent', validation });
      }
    }
  } finally { await pool.end(); }
  const results = audit.results.map((r: Record<string, any>) => {
    const priceCheck = observed.get(`${r.symbol}.${r.market}`);
    const passed = priceCheck?.pass !== false && (r.independent?.status === 'independently_consistent' || priceCheck?.pass === true);
    return { ...r, repairs: repaired.get(r.symbol) ?? [], priceCheck,
      conclusion: r.status === 'no_bars_in_window' ? 'no_bars_in_window' : passed ? 'verified' : 'needs_review' };
  });
  const counts: Record<string, number> = {}; const reasons: Record<string, number> = {};
  for (const r of results) {
    counts[r.conclusion] = (counts[r.conclusion] ?? 0) + 1;
    if (r.conclusion === 'needs_review') {
      const reason = String(r.independent?.error ?? r.status); reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }
  const summary = { ...audit.summary, conclusions: counts, reviewReasons: reasons, repairedStocks: repaired.size,
    repairTransactions: [...repaired.values()].reduce((n, rows) => n + rows.length, 0),
    observedPriceChecks: observed.size, observedPricePasses: [...observed.values()].filter(r => r.pass).length,
    compiledAt: new Date().toISOString() };
  await writeFile(resolve(root, 'final-report.json'), JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
