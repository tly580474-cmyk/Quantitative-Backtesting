import 'dotenv/config';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, initDb } from '../db/index.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';
import {
  calculateFundamentalAndValuationSeries,
} from './calculation/fundamentalValuation.js';
import { calculateNominalEarningsCycleSeries } from './calculation/nominalEarningsCycle.js';
import { queryFundamentalValuationRawPoints } from './jobs/fundamentalValuationJob.js';
import { listLatestAvailableMacroObservations } from './macroRepository.js';
import {
  getLatestMarketHealthSnapshot,
  insertMarketHealthHistoricalSnapshots,
} from './repository.js';
import { invalidateMarketHealthCache } from './service.js';
import type { MarketHealthSnapshotInput } from './types.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  const pool = createPool(config);
  initDb(pool);
  try {
    const snapshotRoot = resolve(config.RESEARCH_SNAPSHOT_ROOT);
    const current = await readCurrentSnapshot(snapshotRoot);
    if (!current) throw new Error('研究快照不存在，无法回填健康指标历史');
    const financial = current.manifest.datasets?.find((item) => item.name === 'financial_reports');
    if (!financial) throw new Error('研究快照缺少 financial_reports 数据集');

    const calculatedAt = new Date();
    const [rawPoints, ppi, latestFhi, latestNec, latestVpi] = await Promise.all([
      queryFundamentalValuationRawPoints(
        snapshotRoot,
        current.manifest.snapshotId,
        financial.relativePath,
        10_000,
      ),
      listLatestAvailableMacroObservations('ppi_yoy', calculatedAt.toISOString()),
      getLatestMarketHealthSnapshot('fhi'),
      getLatestMarketHealthSnapshot('nec'),
      getLatestMarketHealthSnapshot('vpi'),
    ]);

    const fundamentalValuation = calculateFundamentalAndValuationSeries(
      rawPoints,
      current.manifest.snapshotId,
      calculatedAt,
    );
    const candidates = [
      ...firstPublishedFhiByReportPeriod(fundamentalValuation.fhi),
      ...calculateNominalEarningsCycleSeries(ppi, calculatedAt),
      ...monthEndSnapshots(fundamentalValuation.vpi),
    ];
    const latestByIndicator = { fhi: latestFhi, nec: latestNec, vpi: latestVpi };
    const safeHistory = candidates.filter((item) => {
      const latest = latestByIndicator[item.indicatorKey as keyof typeof latestByIndicator];
      return !latest || item.asOfDate < latest.asOfDate;
    });

    const summary = summarize(safeHistory);
    if (apply) {
      await insertMarketHealthHistoricalSnapshots(safeHistory);
      invalidateMarketHealthCache();
    }
    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      sourceSnapshotId: current.manifest.snapshotId,
      rawTradingDays: rawPoints.length,
      ppiObservations: ppi.length,
      ...summary,
    }));
  } finally {
    closeDb();
    await closePool(pool);
  }
}

export function firstPublishedFhiByReportPeriod(
  snapshots: MarketHealthSnapshotInput[],
): MarketHealthSnapshotInput[] {
  const firstByPeriod = new Map<string, MarketHealthSnapshotInput>();
  for (const snapshot of snapshots) {
    if (snapshot.publicationStatus !== 'published' || firstByPeriod.has(snapshot.periodKey)) continue;
    firstByPeriod.set(snapshot.periodKey, snapshot);
  }
  return [...firstByPeriod.values()];
}

export function monthEndSnapshots(
  snapshots: MarketHealthSnapshotInput[],
): MarketHealthSnapshotInput[] {
  const lastByMonth = new Map<string, MarketHealthSnapshotInput>();
  for (const snapshot of snapshots) lastByMonth.set(snapshot.asOfDate.slice(0, 7), snapshot);
  return [...lastByMonth.values()];
}

function summarize(snapshots: MarketHealthSnapshotInput[]) {
  return Object.fromEntries(['fhi', 'nec', 'vpi'].map((indicatorKey) => {
    const items = snapshots.filter((item) => item.indicatorKey === indicatorKey);
    return [indicatorKey, {
      points: items.length,
      minDate: items[0]?.asOfDate ?? null,
      maxDate: items.at(-1)?.asOfDate ?? null,
    }];
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
