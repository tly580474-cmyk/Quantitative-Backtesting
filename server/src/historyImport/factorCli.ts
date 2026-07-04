import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { closePool, createPool } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { importAdjustmentFactors } from './factorImporter.js';

interface CliOptions {
  sourceRoot: string;
  codes?: string[];
  limit?: number;
  batchId?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool(loadConfig());
  const batchId = args.batchId ?? randomUUID();
  console.log(`复权因子批次 ID: ${batchId}`);
  try {
    const migration = await runMigrations(pool);
    if (migration.errors.length > 0) throw new Error(migration.errors.join('; '));
    const startedAt = Date.now();
    const result = await importAdjustmentFactors(pool, {
      sourceRoot: args.sourceRoot,
      codes: args.codes,
      limit: args.limit,
      batchId,
      reportRoot: resolve('.cache/history-import'),
      onProgress: (progress) => {
        const ratio = progress.totalFiles === 0
          ? 0
          : progress.completedFiles / progress.totalFiles;
        const width = 28;
        const filled = Math.floor(width * ratio);
        const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
        process.stdout.write(
          `\r复权因子 [${bar}] ${(ratio * 100).toFixed(2).padStart(6)}% `
          + `${progress.completedFiles}/${progress.totalFiles} `
          + `${progress.storedFactors.toLocaleString()} 个因子 `
          + `${progress.currentFile}   `,
        );
      },
    });
    process.stdout.write('\n');
    console.log(JSON.stringify({
      ...result,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
    }, null, 2));
  } finally {
    await closePool(pool);
  }
}

function parseArgs(argv: string[]): CliOptions {
  let sourceRoot = process.env.STOCK_HISTORY_ROOT ?? '';
  let codes: string[] | undefined;
  let limit: number | undefined;
  let batchId: string | undefined;
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
    else if (arg === '--batch-id') batchId = next();
    else if (arg === '--help') {
      console.log(`复权因子计算器

用法：
  npm run import:factors -- --source <目录> --codes 000001,600000
  npm run import:factors -- --source <目录> --limit 100
  npm run import:factors -- --source <目录> --batch-id <UUID>

参数：
  --source       包含“不复权/前复权/后复权”目录的数据根目录
  --codes        逗号分隔的证券代码
  --limit        最多处理多少只证券
  --batch-id     复用批次 ID，从已完成文件之后继续`);
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!sourceRoot) throw new Error('请通过 --source 或 STOCK_HISTORY_ROOT 指定数据根目录');
  return { sourceRoot: resolve(sourceRoot), codes, limit, batchId };
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`);
  return parsed;
}

main().catch((error) => {
  process.stderr.write(`复权因子计算失败：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
