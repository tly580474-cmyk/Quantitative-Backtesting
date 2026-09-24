import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { createPool } from '../../db/connection.js';
import { loadConfig } from '../../config.js';
import type { CompressedFactor, PriceRow } from '../../historyImport/factor.js';
import { auditDistributionEvents, type DistributionEvent } from './adjustmentEventAudit.js';
import { buildEventValidatedPlan } from './adjustmentEventPlan.js';

async function main() {
  const [start, end, eventFile, output, sinaDirectory] = process.argv.slice(2);
  if (!start || !end || !eventFile || !output) throw new Error('Usage: start end event-json output');
  const source = JSON.parse(await readFile(eventFile, 'utf8')) as Record<string, unknown>[];
  const bySymbol = new Map<string, DistributionEvent[]>();
  const seen = new Set<string>();
  for (const e of source) {
    const symbol = String(e.SECUCODE);
    const date = String(e.EX_DIVIDEND_DATE).slice(0, 10);
    if (date < start || date > end || e.ASSIGN_PROGRESS !== '实施分配') continue;
    const key = `${symbol}:${date}:${e.REPORT_DATE}`;
    if (seen.has(key)) throw new Error(`Duplicate source event: ${key}`);
    seen.add(key);
    const events = bySymbol.get(symbol) ?? [];
    const cashPerShare = Number(e.PRETAX_BONUS_RMB ?? 0) / 10;
    const sharesPerShare = Number(e.BONUS_IT_RATIO ?? 0) / 10;
    // Same-day independent distributions are aggregated before applying their single ex-price.
    const previous = events.find(event => event.date === date);
    if (previous) { previous.cashPerShare += cashPerShare; previous.sharesPerShare += sharesPerShare; }
    else events.push({ date, cashPerShare, sharesPerShare });
    bySymbol.set(symbol, events);
  }
  const pool = createPool(loadConfig()); const results = [];
  const root = resolve(output); await mkdir(root, { recursive: true });
  if (sinaDirectory) await mkdir(resolve(root, 'symbols'), { recursive: true });
  try {
    const [targets] = await pool.query<RowDataPacket[]>(`SELECT i.instrument_key,i.id,i.symbol,i.market,i.name,
      p.factor_version FROM instruments i LEFT JOIN adjustment_factor_publications p ON p.instrument_key=i.instrument_key
      WHERE i.type='stock' ORDER BY i.symbol`);
    for (const target of targets) {
      const columns = "DATE_FORMAT(trade_date,'%Y-%m-%d') tradeDate,open,high,low,close,previous_close previousClose,source_key sourceKey";
      const [bars] = await pool.query<(RowDataPacket & PriceRow & { previousClose: number | null; sourceKey: number })[]>(
        `(SELECT ${columns} FROM daily_bars_v2 WHERE instrument_key=? AND is_final=1 AND trade_date BETWEEN ? AND ?)
        UNION ALL (SELECT ${columns} FROM daily_bars_v2 WHERE instrument_key=? AND is_final=1 AND trade_date<?
        ORDER BY trade_date DESC LIMIT 1) ORDER BY tradeDate`, [target.instrument_key, start, end, target.instrument_key, start]);
      const [factors] = await pool.query<(RowDataPacket & CompressedFactor)[]>(`SELECT DATE_FORMAT(effective_date,'%Y-%m-%d') effectiveDate,
        factor,price_offset AS offset FROM adjustment_factors_v2 WHERE instrument_key=? AND factor_version=? ORDER BY effective_date`,
      [target.instrument_key, target.factor_version ?? '']);
      const events = bySymbol.get(`${target.symbol}.${target.market}`) ?? [];
      const checks = auditDistributionEvents(bars, factors, events);
      const rows = bars.filter(b => b.tradeDate >= start);
      const unexplainedBoundaries = factors.filter((f, index) => {
        if (!index || f.effectiveDate < start || f.effectiveDate > end) return false;
        if (events.some(e => e.date === f.effectiveDate)) return false;
        const previous = factors[index - 1];
        const prior = bars.filter(b => b.tradeDate < f.effectiveDate).at(-1);
        if (!prior) return false;
        const anchor = factors.at(-1)!;
        return Math.abs(prior.close * (f.factor - previous.factor) + f.offset - previous.offset) / anchor.factor > 0.025;
      });
      const status = !rows.length ? 'no_bars_in_window' : !factors.length ? 'missing_factors'
        : checks.some(e => e.status !== 'event_consistent') ? 'event_disagreement'
        : unexplainedBoundaries.length ? 'unexplained_boundaries'
        : events.length ? 'events_consistent' : 'no_known_distribution';
      let independent: { status: string; error?: string; beforeMaxError?: number; method?: string } | undefined;
      if (sinaDirectory && rows.length) {
        try {
          const reference = JSON.parse(await readFile(resolve(sinaDirectory, `${target.symbol}.${target.market}.json`), 'utf8'));
          if (reference.status !== 'ready') throw new Error(`Independent source unavailable: ${reference.error}`);
          const plan = buildEventValidatedPlan({ start, end, raw: bars, factors, events, sina: reference.factors });
          independent = { status: plan.changed ? 'event_repairable' : 'independently_consistent',
            beforeMaxError: plan.beforeValidation.maxAbsoluteError, method: plan.validationMethod };
          if (plan.changed) {
            const [publications] = await pool.query<RowDataPacket[]>(
              'SELECT * FROM adjustment_factor_publications WHERE instrument_key=?', [target.instrument_key]);
            if (publications[0]?.factor_version !== target.factor_version) throw new Error('Publication changed during audit');
            const raw = rows.map(r => ({ tradeDate: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close }));
            await writeFile(resolve(root, 'symbols', `${target.symbol}.${target.market}.json`), JSON.stringify({
              target, start, end, source: 'eastmoney+sina:events', auditBars: bars, raw, factors,
              publication: publications[0], events, sina: reference.factors, plan, result: independent,
            }, null, 2));
          }
        } catch (error) { independent = { status: 'needs_review', error: String(error) }; }
      }
      results.push({ ...target, status, bars: rows.length, events: checks, unexplainedBoundaries, independent });
      if (results.length % 1000 === 0) console.log(JSON.stringify({ completed: results.length, total: targets.length }));
    }
    const counts: Record<string, number> = {}; const eventCounts: Record<string, number> = {};
    const independentCounts: Record<string, number> = {};
    for (const r of results) {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      for (const e of r.events) eventCounts[e.status] = (eventCounts[e.status] ?? 0) + 1;
      if (r.independent) independentCounts[r.independent.status] = (independentCounts[r.independent.status] ?? 0) + 1;
    }
    const summary = { start, end, checkedAt: new Date().toISOString(), targets: targets.length,
      sourceRows: source.length, counts, eventCounts, independentCounts };
    await writeFile(resolve(root, 'audit.json'), JSON.stringify({ summary, results }, null, 2));
    console.log(JSON.stringify(summary));
  } finally { await pool.end(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
