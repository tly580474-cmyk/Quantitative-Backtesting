import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { createPool, closePool } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { importStockHistory } from './importer.js';

interface CliOptions {
  sourceRoot: string;
  codes?: string[];
  limit?: number;
  chunkRows?: number;
  fallbackBatchRows?: number;
  requireLocalInfile: boolean;
  batchId?: string;
  dryRun: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const pool = args.dryRun ? null : createPool(config);
  const batchId = args.batchId ?? randomUUID();
  console.log(`批次 ID: ${batchId}`);
  try {
    if (pool) {
      const migration = await runMigrations(pool);
      if (migration.errors.length > 0) {
        throw new Error(migration.errors.join('; '));
      }
    }
    const started = Date.now();
    const result = await importStockHistory(pool, {
      sourceRoot: args.sourceRoot,
      codes: args.codes,
      limit: args.limit,
      chunkRows: args.chunkRows,
      fallbackBatchRows: args.fallbackBatchRows,
      requireLocalInfile: args.requireLocalInfile,
      batchId,
      dryRun: args.dryRun,
      cacheRoot: resolve('.cache/history-import'),
      onProgress: (progress) => {
        const ratio = progress.totalFiles
          ? (progress.completedFiles / progress.totalFiles) * 100
          : 0;
        process.stdout.write(
          `\r[${progress.status}] ${ratio.toFixed(1)}% `
          + `${progress.completedFiles}/${progress.totalFiles} `
          + `${progress.importedRows.toLocaleString()} 行 ${progress.currentFile}   `,
        );
      },
    });
    process.stdout.write('\n');
    console.log(JSON.stringify({
      ...result,
      elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    }, null, 2));
  } finally {
    if (pool) await closePool(pool);
  }
}

function parseArgs(argv: string[]): CliOptions {
  let sourceRoot = process.env.STOCK_HISTORY_ROOT ?? '';
  let codes: string[] | undefined;
  let limit: number | undefined;
  let chunkRows: number | undefined;
  let fallbackBatchRows: number | undefined;
  let batchId: string | undefined;
  let requireLocalInfile = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} 缺少参数`);
      return value;
    };
    if (arg === '--source') sourceRoot = next();
    else if (arg === '--codes') codes = next().split(',').filter(Boolean);
    else if (arg === '--limit') limit = positiveInteger(next(), arg);
    else if (arg === '--chunk-rows') chunkRows = positiveInteger(next(), arg);
    else if (arg === '--fallback-batch-rows') fallbackBatchRows = positiveInteger(next(), arg);
    else if (arg === '--require-local-infile') requireLocalInfile = true;
    else if (arg === '--batch-id') batchId = next();
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help') {
      console.log(`历史行情导入器

用法：
  npm run import:history -- --source <目录> --limit 10 --dry-run
  npm run import:history -- --source <目录> --codes 000001,600000
  npm run import:history -- --source <目录> --batch-id <UUID>

参数：
  --source       包含“不复权”目录的历史数据根目录
  --codes        逗号分隔的证券代码
  --limit        最多处理多少个文件
  --chunk-rows   每个 LOAD DATA 分片行数（默认 50000）
  --fallback-batch-rows  LOCAL INFILE 不可用时每批 REPLACE 行数（默认 1000）
  --require-local-infile 禁止降级；local_infile 不可用时立即失败
  --batch-id     复用批次 ID 以继续未完成任务
  --dry-run      仅预检，不连接或写入数据库`);
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!sourceRoot) throw new Error('请通过 --source 或 STOCK_HISTORY_ROOT 指定历史数据根目录');
  return {
    sourceRoot: resolve(sourceRoot),
    codes,
    limit,
    chunkRows,
    fallbackBatchRows,
    batchId,
    requireLocalInfile,
    dryRun,
  };
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return parsed;
}

main().catch((error) => {
  process.stderr.write(`历史行情导入失败：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
