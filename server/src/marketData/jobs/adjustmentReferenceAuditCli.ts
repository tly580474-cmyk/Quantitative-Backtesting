import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { createPool } from '../../db/connection.js';
import { loadConfig } from '../../config.js';
import { TencentMarketDataProvider } from '../providers/tencentProvider.js';
import { validateReconstruction, type CompressedFactor, type PriceRow } from '../../historyImport/factor.js';
import { buildAdjustmentBaseline } from './adjustmentBaseline.js';
import { buildAdjustmentRefreshPlan } from './adjustmentRefresh.js';

interface Target extends RowDataPacket {
  instrument_key: number; id: string; symbol: string; name: string; market: string; status: string;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function main() {
  const [start, end, output, workerInput = '1', source = 'tencent'] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '') || start > end || !output) {
    throw new Error('Usage: adjustmentReferenceAuditCli.ts start end output-directory [workers] [tencent|eastmoney]');
  }
  const workers = Number(workerInput);
  if (!Number.isInteger(workers) || workers < 1 || workers > 6) throw new Error('workers must be 1..6');
  if (!['tencent', 'eastmoney'].includes(source)) throw new Error('Unknown reference source');
  const root = resolve(output); await mkdir(resolve(root, 'symbols'), { recursive: true });
  const pool = createPool(loadConfig());
  const results: Record<string, unknown>[] = [];
  let cursor = 0;
  let stopped = false;
  let consecutiveFailures = 0;
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  // One shared limiter across workers. Do not multiply the provider's allowance by worker count.
  const waitForRequest = () => {
    const turn = queue.then(async () => {
      await delay(Math.max(0, nextRequestAt - Date.now()));
      nextRequestAt = Date.now() + (source === 'tencent' ? 3100 : 600);
    });
    queue = turn.catch(() => {});
    return turn;
  };
  try {
    const [targets] = await pool.query<Target[]>(`SELECT i.instrument_key,i.id,i.symbol,i.name,i.market,i.status
      FROM instruments i WHERE i.type='stock' AND EXISTS (SELECT 1 FROM daily_bars_v2 b
      WHERE b.instrument_key=i.instrument_key AND b.is_final=1 AND b.trade_date BETWEEN ? AND ?)
      ORDER BY (i.symbol='600426') DESC,i.symbol`, [start, end]);
    // Investigate known discontinuities first, but do not exclude any previously validated stock.
    try {
      const eventAudit = JSON.parse(await readFile(resolve(root, '..', 'event-check', 'audit.json'), 'utf8'));
      const priority = new Set(eventAudit.results.filter((r: {status: string}) => r.status === 'event_disagreement')
        .map((r: {symbol: string; market: string}) => `${r.symbol}.${r.market}`));
      targets.sort((a, b) => Number(priority.has(`${b.symbol}.${b.market}`)) - Number(priority.has(`${a.symbol}.${a.market}`)));
    } catch { /* Independent reference audit is also usable without an event audit. */ }
    console.log(JSON.stringify({ start, end, source, targets: targets.length, workers, root }));
    await writeFile(resolve(root, 'targets.json'), JSON.stringify(targets, null, 2));
    const progress = async () => {
      const counts: Record<string, number> = {};
      for (const r of results) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
      const summary = { start, end, source, targets: targets.length, completed: results.length, stopped, counts,
        checkedAt: new Date().toISOString(), root };
      await writeFile(resolve(root, 'progress.json'), JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(summary));
    };
    await Promise.all(Array.from({ length: workers }, async () => {
      const provider = new TencentMarketDataProvider();
      while (cursor < targets.length && !stopped) {
        const target = targets[cursor++];
        const path = resolve(root, 'symbols', `${target.symbol}.${target.market}.json`);
        try {
          const cached = JSON.parse(await readFile(path, 'utf8'));
          if (cached.start === start && cached.end === end && cached.source === source && cached.result.status !== 'error') {
            results.push(cached.result); continue;
          }
        } catch { /* Resume only this explicitly selected audit directory. */ }
        let evidence: Record<string, unknown> = { target, start, end, source };
        let result: Record<string, unknown>;
        try {
          const [publication] = await pool.query<RowDataPacket[]>(
            'SELECT * FROM adjustment_factor_publications WHERE instrument_key=?', [target.instrument_key]);
          const [factors] = await pool.query<(RowDataPacket & CompressedFactor)[]>(`SELECT
            DATE_FORMAT(effective_date,'%Y-%m-%d') effectiveDate,factor,price_offset AS offset
            FROM adjustment_factors_v2 WHERE instrument_key=? AND factor_version=? ORDER BY effective_date`,
          [target.instrument_key, publication[0]?.factor_version ?? '']);
          const [raw] = await pool.query<(RowDataPacket & PriceRow)[]>(`SELECT
            DATE_FORMAT(trade_date,'%Y-%m-%d') tradeDate,open,high,low,close
            FROM daily_bars_v2 WHERE instrument_key=? AND is_final=1 AND trade_date BETWEEN ? AND ? ORDER BY trade_date`,
          [target.instrument_key, start, end]);
          evidence = { ...evidence, publication: publication[0] ?? null, factors, raw, rawFingerprint: digest(raw) };
          const fetchPrices = async (adjustment: 'qfq' | 'none') => {
            for (let attempt = 0; ; attempt++) {
              try {
                await waitForRequest();
                if (stopped) throw new Error('Reference source circuit is open');
                if (source === 'eastmoney') {
                  const prices = await fetchEastmoneyPrices(target, raw[0].tradeDate, raw.at(-1)!.tradeDate, adjustment);
                  consecutiveFailures = 0;
                  return prices;
                }
                // Explicit exchange prevents 000001/000688 stocks from resolving to Shanghai indices.
                const rows = await provider.fetchDailyCandles({ symbols: [`${target.symbol}.${target.market}`],
                  startDate: raw[0].tradeDate, endDate: raw.at(-1)!.tradeDate, adjustment });
                consecutiveFailures = 0;
                return rows.filter(r => r.date >= raw[0].tradeDate && r.date <= raw.at(-1)!.tradeDate)
                  .map(r => ({ tradeDate: r.date, open: r.open, high: r.high, low: r.low, close: r.close }));
              } catch (error) {
                consecutiveFailures++;
                if (/HTTP (403|429|501)/.test(String(error)) || consecutiveFailures >= 6) stopped = true;
                if (stopped || attempt >= 2) throw error;
                await delay(5000 * (attempt + 1));
              }
            }
          };
          const qfq = await fetchPrices('qfq');
          evidence.qfq = qfq;
          const dates = new Set(qfq.map(r => r.tradeDate));
          const missingDates = raw.filter(r => !dates.has(r.tradeDate)).map(r => r.tradeDate);
          const validation = validateReconstruction(raw, qfq, factors, 'qfq');
          result = { symbol: target.symbol, market: target.market, instrumentKey: target.instrument_key,
            name: target.name, status: 'pass', bars: raw.length, referenceRows: qfq.length,
            factorVersion: publication[0]?.factor_version, validation, missingDates };
          if (missingDates.length || !qfq.length) result.status = 'incomplete_reference';
          else if (!factors.length || validation.withinTickRatio < 0.995 || validation.maxAbsoluteError > 0.025) {
            const referenceRaw = await fetchPrices('none'); evidence.referenceRaw = referenceRaw;
            const rawDates = new Map(referenceRaw.map(r => [r.tradeDate, r]));
            const rawMismatches = raw.filter(r => {
              const ref = rawDates.get(r.tradeDate);
              return !ref || (['open', 'high', 'low', 'close'] as const).some(k => Math.abs(ref[k] - r[k]) > 0.01000001);
            });
            result.rawMismatchCount = rawMismatches.length;
            evidence.rawMismatches = rawMismatches;
            if (rawMismatches.length) result.status = 'raw_mismatch';
            else {
              try {
                const baseline = buildAdjustmentBaseline(raw, qfq);
                const plan = buildAdjustmentRefreshPlan(factors, raw, qfq);
                evidence.baseline = baseline; evidence.plan = plan;
                result.status = plan.changed && plan.validation.maxAbsoluteError <= 0.025
                  ? 'repairable' : 'needs_manual_plan';
                result.planReason = plan.reason;
              } catch (error) { result.status = 'derivation_failed'; result.error = String(error); }
            }
          }
          evidence.result = result;
        } catch (error) {
          result = { symbol: target.symbol, market: target.market, name: target.name, status: 'error',
            error: error instanceof Error ? error.message : String(error) };
          evidence.result = result;
        }
        await writeFile(path, JSON.stringify(evidence, null, 2));
        results.push(result);
        if (target.symbol === '600426') console.log(JSON.stringify(result));
        if (results.length % 50 === 0) await progress();
      }
    }));
    await progress();
    await writeFile(resolve(root, 'results.json'), JSON.stringify(results, null, 2));
    if (stopped) process.exitCode = 2;
  } finally { await pool.end(); }
}

async function fetchEastmoneyPrices(target: Target, start: string, end: string, adjustment: 'qfq' | 'none'): Promise<PriceRow[]> {
  const params = new URLSearchParams({ fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61', ut: '7eea3edcaed734bea9cbfc24409ed989',
    klt: '101', fqt: adjustment === 'qfq' ? '1' : '0', secid: `${target.market === 'SH' ? 1 : 0}.${target.symbol}`,
    beg: start.replaceAll('-', ''), end: end.replaceAll('-', '') });
  const response = await fetch(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`, {
    signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
  });
  if (!response.ok) throw new Error(`Eastmoney HTTP ${response.status}`);
  const payload = await response.json() as { rc?: number; data?: { code: string; klines?: string[] } | null };
  if (payload.data && payload.data.code !== target.symbol) throw new Error('Reference symbol mismatch');
  if (payload.rc && payload.rc !== 0) throw new Error(`Eastmoney response code ${payload.rc}`);
  return (payload.data?.klines ?? []).map(line => {
    const [tradeDate, open, close, high, low] = line.split(',');
    const row = { tradeDate, open: Number(open), high: Number(high), low: Number(low), close: Number(close) };
    if ([row.open, row.high, row.low, row.close].some(v => !Number.isFinite(v))) throw new Error('Invalid reference OHLC');
    return row;
  }).filter(row => row.tradeDate >= start && row.tradeDate <= end);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
