import 'dotenv/config';
import { loadConfig } from '../config.js';
import { pruneResearchSnapshots } from './snapshotRetention.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (config.RESEARCH_SNAPSHOT_RETENTION_ENABLED !== 'true') {
    console.log(JSON.stringify({ status: 'disabled' }, null, 2));
    return;
  }
  const report = await pruneResearchSnapshots({
    root: config.RESEARCH_SNAPSHOT_ROOT,
    retainLatest: Number(config.RESEARCH_SNAPSHOT_RETAIN_LATEST),
    retainDailyDays: Number(config.RESEARCH_SNAPSHOT_RETAIN_DAILY_DAYS),
    dryRun: !apply,
  });
  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
