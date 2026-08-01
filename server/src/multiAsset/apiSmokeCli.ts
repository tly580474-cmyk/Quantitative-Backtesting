import 'dotenv/config';
import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { closeDb, initDb } from '../db/index.js';
import { registerMultiAssetRoutes } from '../routes/multiAsset.js';

const config = loadConfig();
const pool = createPool(config);
initDb(pool);
const app = Fastify({ logger: false });
registerMultiAssetRoutes(app, true, {
  snapshotRoot: config.RESEARCH_SNAPSHOT_ROOT,
  pythonExecutable: config.FACTOR_MINER_PYTHON,
});

try {
  const plansResponse = await app.inject({ method: 'GET', url: '/api/multi-asset/plans?limit=1' });
  if (plansResponse.statusCode !== 200) throw new Error(`API_SMOKE_LIST_PLANS:${plansResponse.statusCode}`);
  const plans = plansResponse.json<Array<{ id: string }>>();
  if (!plans[0]) throw new Error('API_SMOKE_PLAN_REQUIRED');
  const planId = plans[0].id;
  const idempotencyKey = `m4-api-smoke:${planId}`;
  const start = await app.inject({
    method: 'POST', url: `/api/multi-asset/plans/${planId}/runs`,
    payload: { idempotencyKey, initialCash: 1_000_000 },
  });
  if (![200, 202].includes(start.statusCode)) throw new Error(`API_SMOKE_START:${start.statusCode}:${start.body}`);
  const runId = start.json<{ run: { id: string } }>().run.id;
  let completed: { status?: string; resultHash?: string; errorCode?: string } | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/multi-asset/runs/${runId}` });
    if (response.statusCode !== 200) throw new Error(`API_SMOKE_GET_RUN:${response.statusCode}`);
    const current = response.json<{ status?: string; resultHash?: string; errorCode?: string }>();
    completed = current;
    if (current.status === 'completed' || current.status === 'failed') break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (completed?.status !== 'completed' || !completed.resultHash) {
    throw new Error(`API_SMOKE_RUN_FAILED:${completed?.errorCode ?? completed?.status ?? 'timeout'}`);
  }
  const replay = await app.inject({
    method: 'POST', url: `/api/multi-asset/plans/${planId}/runs`,
    payload: { idempotencyKey, initialCash: 1_000_000 },
  });
  if (replay.statusCode !== 200) throw new Error(`API_SMOKE_REPLAY:${replay.statusCode}`);
  const conflict = await app.inject({
    method: 'POST', url: `/api/multi-asset/plans/${planId}/runs`,
    payload: { idempotencyKey, initialCash: 1_000_001 },
  });
  if (conflict.statusCode !== 409) throw new Error(`API_SMOKE_CONFLICT:${conflict.statusCode}`);
  process.stdout.write(`${JSON.stringify({
    status: 'api_foundation_smoke_passed', planId, runId,
    resultHash: completed.resultHash, asyncStartStatus: start.statusCode,
    idempotentReplayStatus: replay.statusCode, conflictStatus: conflict.statusCode,
  }, null, 2)}\n`);
} finally {
  await app.close();
  await closeDb();
  await closePool(pool);
}
