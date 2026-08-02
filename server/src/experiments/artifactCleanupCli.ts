import 'dotenv/config';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { initDb } from '../db/index.js';
import { cleanupExpiredReportArtifacts } from './m3Repository.js';

async function main(): Promise<void> {
  const pool = createPool(loadConfig());
  initDb(pool);
  try {
    const removed = await cleanupExpiredReportArtifacts();
    console.log(JSON.stringify({
      removed,
      htmlRetentionDays: Number(process.env.EXPERIMENT_REPORT_HTML_RETENTION_DAYS || 7),
      pdfRetentionDays: Number(process.env.EXPERIMENT_REPORT_PDF_RETENTION_DAYS || 30),
    }, null, 2));
  } finally {
    await closePool(pool);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
