import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { initDb } from '../db/index.js';
import { getDb, schema } from '../db/index.js';
import { canonicalHash } from './schema.js';
import {
  enqueueReportArtifact,
  getReportArtifactJob,
  getReportWorkerStatus,
  listExperimentReportHistory,
} from './m3Repository.js';

function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  initDb(pool);
  let child: ReturnType<typeof spawn> | null = null;
  let temporaryReportId: string | null = null;
  let artifactPath: string | null = null;
  let artifactJobId: string | null = null;
  try {
    const [latest] = await listExperimentReportHistory(1);
    let reportId = latest?.report.id;
    if (!reportId) {
      temporaryReportId = randomUUID();
      reportId = temporaryReportId;
      const markdown = '# M3 PDF Worker 冒烟报告\n\n| 指标 | 数值 |\n|---|---:|\n| 状态隔离 | 通过 |';
      await getDb().insert(schema.strategyExperimentReports).values({
        id: reportId,
        runId: randomUUID(),
        templateVersion: 'smoke-1.0.0',
        structuredReport: { smoke: true },
        markdown,
        reportHash: canonicalHash({ markdown, smoke: true }),
        createdAt: new Date().toISOString(),
      });
    }
    const queued = await enqueueReportArtifact(reportId, 'pdf');
    if (!queued) throw new Error('SMOKE_ENQUEUE_FAILED');
    artifactJobId = queued.job.id;
    if (queued.job.status !== 'completed') {
      const tsxCli = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
      child = spawn(process.execPath, [tsxCli, 'src/experiments/reportWorkerCli.ts'], {
        cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
      child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    }
    const deadline = Date.now() + 45_000;
    let job = await getReportArtifactJob(queued.job.id);
    while (job && (job.status === 'queued' || job.status === 'running') && Date.now() < deadline) {
      await delay(500);
      job = await getReportArtifactJob(queued.job.id);
    }
    if (!job || job.status !== 'completed' || !job.artifactUri) {
      throw new Error(`SMOKE_PDF_FAILED: ${job?.status ?? 'missing'} ${job?.errorMessage ?? ''}`);
    }
    await access(job.artifactUri);
    artifactPath = job.artifactUri;
    if (!job.checksum || !job.byteSize || job.byteSize < 1000 || job.mimeType !== 'application/pdf') {
      throw new Error('SMOKE_METADATA_INVALID');
    }
    const worker = await getReportWorkerStatus();
    console.log(JSON.stringify({
      ok: true,
      jobId: job.id,
      reportId: job.reportId,
      byteSize: job.byteSize,
      checksum: job.checksum,
      generatorVersion: job.generatorVersion,
      workerObserved: worker.workers.length > 0,
      runStatusUnaffected: latest?.run.status ?? 'no-run-smoke-fixture',
    }, null, 2));
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await delay(250);
    if (temporaryReportId) {
      if (artifactJobId) {
        await getDb().delete(schema.strategyExperimentArtifactJobs)
          .where(eq(schema.strategyExperimentArtifactJobs.id, artifactJobId));
      }
      await getDb().delete(schema.strategyExperimentReports)
        .where(eq(schema.strategyExperimentReports.id, temporaryReportId));
      if (artifactPath) await unlink(artifactPath).catch(() => undefined);
    }
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
