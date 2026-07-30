import type { Pool } from 'mysql2/promise';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addStrategyEvaluation,
  createStrategyVersion,
  getStrategyPerformance,
  hasStrategyEvaluationSince,
  listStrategyVersions,
} from './strategyRepository.js';
import { isQuarterlyChallengerDue } from './strategyGovernance.js';

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startStrategyIterationScheduler(pool: Pool, intervalMs = 3_600_000): void {
  if (timer) return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runStrategyIterationTick(pool); }
    catch (error) { console.error('[StrategyIteration] scheduler tick failed:', error); }
    finally { busy = false; }
  };
  void tick();
  timer = setInterval(() => { void tick(); }, Math.max(300_000, intervalMs));
  timer.unref();
}

export function stopStrategyIterationScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function runStrategyIterationTick(pool: Pool, now = new Date()): Promise<void> {
  const versions = await listStrategyVersions(pool);
  const champion = versions.find((item) => item.status === 'champion');
  if (champion) {
    const latestChallenger = versions.find((item) => item.parentVersionId === champion.id);
    if (isQuarterlyChallengerDue(latestChallenger?.createdAt ?? null, now)) {
      const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
      await createStrategyVersion(pool, {
        name: `${champion.name} challenger ${now.getUTCFullYear()}Q${quarter}`,
        parentVersionId: champion.id,
        factorVersions: champion.factorVersions,
        compositeWeights: champion.compositeWeights,
        universeConfig: champion.universeConfig,
        preprocessingConfig: champion.preprocessingConfig,
        optimizerConfig: champion.optimizerConfig,
        costConfig: champion.costConfig,
        snapshotId: champion.snapshotId,
        codeChecksum: champion.codeChecksum,
        randomSeeds: champion.randomSeeds,
      });
    }
  }

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  for (const strategy of versions.filter((item) =>
    item.status === 'paper' || item.status === 'champion')) {
    if (await hasStrategyEvaluationSince(pool, strategy.id, 'monthly-paper-summary', monthStart)) continue;
    const performance = await getStrategyPerformance(pool, strategy.id);
    const metrics = {
      observationCount: performance.observations.length,
      latestObservation: performance.observations.at(-1) ?? null,
      generatedAt: now.toISOString(),
    };
    const artifactUri = await writeMonthlyHtml(strategy.id, strategy.name, metrics);
    await addStrategyEvaluation(pool, {
      strategyVersionId: strategy.id,
      evaluationType: 'monthly-paper-summary',
      metrics,
      gateResult: { passed: true, failures: [] },
      artifactUri,
    });
  }
}

async function writeMonthlyHtml(
  id: string,
  name: string,
  metrics: Record<string, unknown>,
): Promise<string> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const directory = resolve(repoRoot, 'tmp_output', 'strategy-reports');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${id}-${new Date().toISOString().slice(0, 7)}.html`);
  const payload = JSON.stringify(metrics, null, 2).replaceAll('<', '\\u003c');
  const safeName = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  await writeFile(path, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>${safeName} 月报</title><style>
body{font:15px/1.6 system-ui;margin:40px;max-width:1100px}pre{background:#f6f8fa;padding:20px;overflow:auto}
</style><h1>${safeName} 月度模拟盘报告</h1>
<p>本报告为自包含审计工件；正式因子发布、冠军替换和实盘均需人工批准。</p>
<pre id="metrics"></pre><script>
const metrics=${payload};document.getElementById('metrics').textContent=JSON.stringify(metrics,null,2);
</script></html>`, 'utf8');
  return path;
}
