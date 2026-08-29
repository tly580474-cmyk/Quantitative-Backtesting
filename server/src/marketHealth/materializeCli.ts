import 'dotenv/config';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, initDb } from '../db/index.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';
import { calculateFundamentalAndValuation } from './calculation/fundamentalValuation.js';
import {
  queryFundamentalValuationRawPoints,
  refreshFundamentalValuation,
} from './jobs/fundamentalValuationJob.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  const snapshotRoot = resolve(config.RESEARCH_SNAPSHOT_ROOT);
  if (apply) {
    const pool = createPool(config);
    initDb(pool);
    try {
      const result = await refreshFundamentalValuation(snapshotRoot);
      console.log(JSON.stringify({ mode: 'apply', ...result }));
    } finally {
      closeDb();
      await closePool(pool);
    }
    return;
  }
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) throw new Error('研究快照不存在');
  const financial = current.manifest.datasets?.find((item) => item.name === 'financial_reports');
  if (!financial) throw new Error('研究快照缺少 financial_reports 数据集');
  const rows = await queryFundamentalValuationRawPoints(
    snapshotRoot,
    current.manifest.snapshotId,
    financial.relativePath,
  );
  const result = calculateFundamentalAndValuation(rows, current.manifest.snapshotId);
  console.log(JSON.stringify({
    mode: 'dry-run',
    snapshotId: current.manifest.snapshotId,
    observations: rows.length,
    fhi: result.fhi,
    vpi: result.vpi,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
