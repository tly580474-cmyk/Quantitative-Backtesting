import 'dotenv/config';
import { pruneResearchArtifacts } from './artifactLifecycle.js';

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = value('--root') ?? './out';
const partialMaxAgeHours = Number(value('--partial-hours') ?? '24');
if (!Number.isFinite(partialMaxAgeHours) || partialMaxAgeHours < 1) {
  throw new Error('--partial-hours 必须是不小于 1 的数字');
}

const report = await pruneResearchArtifacts({
  root,
  partialMaxAgeHours,
  dryRun: args.includes('--dry-run'),
});
console.log(JSON.stringify(report, null, 2));
