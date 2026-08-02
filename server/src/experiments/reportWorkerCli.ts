import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { initDb } from '../db/index.js';
import {
  claimNextReportArtifactJob,
  heartbeatReportWorker,
  processReportArtifactJob,
  recoverStaleReportArtifactJobs,
  stopReportWorker,
} from './m3Repository.js';

const pollMs = Math.max(250, Number(process.env.EXPERIMENT_REPORT_WORKER_POLL_MS || 1000));
const staleMs = Math.max(30_000, Number(process.env.EXPERIMENT_REPORT_WORKER_STALE_MS || 120_000));
const maxAttempts = Math.max(1, Number(process.env.EXPERIMENT_REPORT_WORKER_MAX_ATTEMPTS || 3));
const timeoutMs = Math.max(5_000, Number(process.env.EXPERIMENT_REPORT_RENDER_TIMEOUT_MS || 60_000));

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  initDb(pool);
  let stopping = false;
  const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    stopping = true;
    void heartbeatReportWorker({ id: workerId, hostname: hostname(), pid: process.pid, status: 'draining' });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(JSON.stringify({
    event: 'experiment_report_worker_started', pollMs, staleMs, maxAttempts, timeoutMs,
    pid: process.pid,
  }));
  try {
    await heartbeatReportWorker({ id: workerId, hostname: hostname(), pid: process.pid });
    heartbeatTimer = setInterval(() => {
      void heartbeatReportWorker({ id: workerId, hostname: hostname(), pid: process.pid }).catch((error) => {
        console.error(JSON.stringify({ event: 'experiment_report_worker_heartbeat_failed', error: String(error) }));
      });
    }, 10_000);
    await recoverStaleReportArtifactJobs(new Date(Date.now() - staleMs), maxAttempts);
    while (!stopping) {
      try {
        const job = await claimNextReportArtifactJob(maxAttempts);
        if (!job) {
          await delay(pollMs);
          continue;
        }
        const startedAt = Date.now();
        const completed = await processReportArtifactJob(job.id, {
          alreadyClaimed: true,
          timeoutMs,
          chromiumExecutable: process.env.EXPERIMENT_REPORT_CHROMIUM_EXECUTABLE,
        });
        console.log(JSON.stringify({
          event: 'experiment_report_job_finished', jobId: job.id, format: job.format,
          status: completed?.status, durationMs: Date.now() - startedAt,
          errorMessage: completed?.errorMessage ?? null,
        }));
      } catch (error) {
        // 常驻 Worker：单次轮询失败（如数据库瞬时抖动）不应导致进程退出。
        console.error(JSON.stringify({
          event: 'experiment_report_loop_error',
          error: error instanceof Error ? error.message : String(error),
        }));
        await delay(pollMs);
      }
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await stopReportWorker(workerId).catch(() => undefined);
    await closePool(pool);
    console.log(JSON.stringify({ event: 'experiment_report_worker_stopped', pid: process.pid }));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
