import 'dotenv/config';
import { loadConfig } from '../config.js';
import {
  benchmarkResearchSnapshot,
  getCurrentResearchSnapshot,
} from './duckdbResearchService.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const current = await getCurrentResearchSnapshot(config.RESEARCH_SNAPSHOT_ROOT);
  if (!current || current.status !== 'validated') {
    throw new Error('尚未发布可用的研究快照');
  }
  const endDate = current.maxDate;
  const startDate = `${Number(endDate.slice(0, 4)) - 1}${endDate.slice(4)}`;
  console.log(JSON.stringify(
    await benchmarkResearchSnapshot(
      config.RESEARCH_SNAPSHOT_ROOT,
      startDate,
      endDate,
    ),
    null,
    2,
  ));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
