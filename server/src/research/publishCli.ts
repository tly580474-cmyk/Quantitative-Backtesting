import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { publishStagedResearchSnapshot } from './snapshotBuilder.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const root = resolve(config.RESEARCH_SNAPSHOT_ROOT);
  const argumentIndex = process.argv.indexOf('--staging');
  const requested = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
  const staging = requested
    ? resolve(root, requested)
    : await findSingleStaging(root);
  console.log(JSON.stringify(
    await publishStagedResearchSnapshot(root, staging),
    null,
    2,
  ));
}

async function findSingleStaging(root: string): Promise<string> {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('.building-'));
  if (entries.length !== 1) {
    throw new Error(`需要恰好一个暂存快照，当前发现 ${entries.length} 个；请使用 --staging 指定`);
  }
  return join(root, entries[0].name);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
