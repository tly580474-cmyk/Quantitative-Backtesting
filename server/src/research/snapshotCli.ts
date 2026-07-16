import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { buildResearchSnapshot } from './snapshotBuilder.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool(config);
  try {
    const manifest = await buildResearchSnapshot(pool, config, {
      root: args.root ?? config.RESEARCH_SNAPSHOT_ROOT,
      snapshotId: args.snapshotId,
      years: args.years,
      full: args.full,
      onProgress: (message) => console.log(`[snapshot] ${message}`),
    });
    console.log(JSON.stringify({
      status: 'ready',
      snapshotId: manifest.snapshotId,
      createdAt: manifest.createdAt,
      rows: manifest.rowCount,
      minDate: manifest.minDate,
      maxDate: manifest.maxDate,
      datasets: manifest.datasets?.map((dataset) => ({
        name: dataset.name,
        rows: dataset.rows,
        minDate: dataset.minDate,
        maxDate: dataset.maxDate,
      })),
    }, null, 2));
  } finally {
    await closePool(pool);
  }
}

function parseArgs(args: string[]): {
  root?: string;
  snapshotId?: string;
  years?: number[];
  full?: boolean;
} {
  const valueAfter = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const yearsValue = valueAfter('--years');
  return {
    root: valueAfter('--root'),
    snapshotId: valueAfter('--snapshot-id'),
    full: args.includes('--full'),
    years: yearsValue
      ? yearsValue.split(',').map(Number).filter((year) => Number.isInteger(year))
      : undefined,
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
