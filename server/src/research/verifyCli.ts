import 'dotenv/config';
import { loadConfig } from '../config.js';
import { verifyCurrentResearchSnapshot } from './snapshotVerifier.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(JSON.stringify(
    await verifyCurrentResearchSnapshot(config.RESEARCH_SNAPSHOT_ROOT),
    null,
    2,
  ));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
