import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig } from '../config.js';
import { readCurrentSnapshot } from './snapshotManifest.js';

type OutputFormat = 'table' | 'json' | 'csv';
type Command = 'help' | 'status' | 'schema' | 'query';

interface CliArgs {
  command: Command;
  db: string;
  snapshotRoot: string;
  sql?: string;
  file?: string;
  out?: string;
  format: OutputFormat;
  noSnapshotView: boolean;
  threads?: string;
  maxMemory?: string;
}

interface SnapshotContext {
  snapshotId: string;
  parquetGlob: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2), config.RESEARCH_SNAPSHOT_ROOT);

  if (args.command === 'help') {
    printHelp();
    return;
  }

  if (args.command === 'status') {
    const current = await readCurrentSnapshot(resolve(args.snapshotRoot));
    await outputRows(
      current
        ? [{
            snapshotId: current.manifest.snapshotId,
            status: current.manifest.status,
            publishedAt: current.pointer.publishedAt,
            sourceVersion: current.manifest.sourceVersion,
            sourcePublishedAt: current.manifest.sourcePublishedAt,
            rowCount: current.manifest.rowCount,
            instrumentCount: current.manifest.instrumentCount,
            minDate: current.manifest.minDate,
            maxDate: current.manifest.maxDate,
            partitions: current.manifest.partitions.length,
          }]
        : [{ status: 'unavailable', snapshotRoot: resolve(args.snapshotRoot) }],
      args,
    );
    return;
  }

  const instance = await DuckDBInstance.create(args.db, {
    access_mode: args.db === ':memory:' ? 'READ_WRITE' : 'READ_WRITE',
    threads: args.threads ?? '4',
    ...(args.maxMemory ? { max_memory: args.maxMemory } : {}),
  });
  const connection = await instance.connect();
  try {
    const snapshot = args.noSnapshotView
      ? null
      : await registerSnapshotView(connection, args.snapshotRoot);

    if (args.command === 'schema') {
      if (!snapshot) {
        throw new Error('尚未发布可用的研究快照，无法查看 bars 视图结构');
      }
      const reader = await connection.runAndReadAll('DESCRIBE bars');
      await outputRows(reader.getRowObjectsJson() as Record<string, unknown>[], args);
      return;
    }

    const sql = await loadSql(args, snapshot);
    const reader = await connection.runAndReadAll(sql);
    await outputRows(reader.getRowObjectsJson() as Record<string, unknown>[], args);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function registerSnapshotView(
  connection: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>,
  snapshotRootInput: string,
): Promise<SnapshotContext | null> {
  const snapshotRoot = resolve(snapshotRootInput);
  const current = await readCurrentSnapshot(snapshotRoot);
  if (!current) return null;
  const parquetGlob = normalizeDuckDbPath(
    join(snapshotRoot, current.manifest.snapshotId, 'bars', 'year=*', '*.parquet'),
  );
  await connection.run(`
    CREATE OR REPLACE VIEW bars AS
    SELECT *
    FROM read_parquet('${escapeSqlLiteral(parquetGlob)}', hive_partitioning = true)
  `);
  return {
    snapshotId: current.manifest.snapshotId,
    parquetGlob,
  };
}

async function loadSql(args: CliArgs, snapshot: SnapshotContext | null): Promise<string> {
  if (args.sql) return args.sql;
  if (args.file) return readFile(resolve(args.file), 'utf8');
  if (snapshot) {
    return `
      SELECT market, symbol, name, tradeDate, close, volume, amount
      FROM bars
      ORDER BY tradeDate DESC, instrumentKey
      LIMIT 20
    `;
  }
  return 'SELECT current_date AS today, current_timestamp AS now';
}

async function outputRows(rows: Record<string, unknown>[], args: CliArgs): Promise<void> {
  const format = args.out ? inferOutputFormat(args.out, args.format) : args.format;
  const content = formatRows(rows, format);
  if (args.out) {
    const outPath = resolve(args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, content, 'utf8');
    console.log(`已写入 ${outPath}`);
    return;
  }
  console.log(content);
}

function parseArgs(rawArgs: string[], defaultSnapshotRoot: string): CliArgs {
  const command = normalizeCommand(rawArgs[0]);
  const args = command === 'help' ? rawArgs.slice(1) : rawArgs.slice(1);
  const getValue = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const format = getValue('--format') ?? getValue('-f') ?? 'table';
  if (!isOutputFormat(format)) throw new Error(`不支持的输出格式：${format}`);

  return {
    command,
    db: getValue('--db') ?? ':memory:',
    snapshotRoot: getValue('--snapshot-root') ?? defaultSnapshotRoot,
    sql: getValue('--sql') ?? getValue('-q'),
    file: getValue('--file'),
    out: getValue('--out') ?? getValue('-o'),
    format,
    noSnapshotView: args.includes('--no-snapshot-view'),
    threads: getValue('--threads'),
    maxMemory: getValue('--max-memory'),
  };
}

function normalizeCommand(value: string | undefined): Command {
  if (!value || value === '--help' || value === '-h') return 'help';
  if (value === 'help') return 'help';
  if (value === 'current') return 'status';
  if (value === 'fields' || value === 'columns') return 'schema';
  if (value === 'sql') return 'query';
  if (value === 'status' || value === 'schema' || value === 'query') return value;
  throw new Error(`未知命令：${value}`);
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === 'table' || value === 'json' || value === 'csv';
}

function inferOutputFormat(path: string, fallback: OutputFormat): OutputFormat {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.csv') return 'csv';
  return fallback;
}

function formatRows(rows: Record<string, unknown>[], format: OutputFormat): string {
  if (format === 'json') return `${JSON.stringify(rows, null, 2)}\n`;
  if (format === 'csv') return toCsv(rows);
  return toTable(rows);
}

function toCsv(rows: Record<string, unknown>[]): string {
  const columns = collectColumns(rows);
  const lines = [
    columns.map(escapeCsvCell).join(','),
    ...rows.map((row) => columns.map((column) => escapeCsvCell(row[column])).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function toTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(0 rows)';
  const columns = collectColumns(rows);
  const textRows = rows.map((row) => columns.map((column) => formatCell(row[column])));
  const widths = columns.map((column, index) => Math.max(
    column.length,
    ...textRows.map((row) => row[index].length),
  ));
  const separator = widths.map((width) => '-'.repeat(width)).join('-+-');
  const header = columns.map((column, index) => column.padEnd(widths[index])).join(' | ');
  const body = textRows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join(' | '))
    .join('\n');
  return `${header}\n${separator}\n${body}\n(${rows.length} rows)`;
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))];
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function normalizeDuckDbPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function printHelp(): void {
  console.log(`
本地 DuckDB CLI

用法：
  npm run duckdb -- status
  npm run duckdb -- schema
  npm run duckdb -- query --sql "SELECT tradeDate, symbol, close FROM bars LIMIT 10"
  npm run duckdb -- query --file ./query.sql --format csv --out ./out/result.csv

命令：
  status      查看当前研究快照指针与 manifest 摘要
  schema      查看自动挂载的 bars 视图字段
  query       执行 SQL。默认会把当前研究快照挂载为 bars 视图
  help        显示帮助

常用参数：
  --sql, -q             直接传入 SQL
  --file                从文件读取 SQL
  --out, -o             写入结果文件；.json/.csv 会自动推断格式
  --format, -f          table | json | csv，默认 table
  --db                  DuckDB 数据库路径，默认 :memory:
  --snapshot-root       研究快照目录，默认读取 RESEARCH_SNAPSHOT_ROOT
  --no-snapshot-view    不自动创建 bars 视图
  --threads             DuckDB 线程数，默认 4
  --max-memory          DuckDB 内存上限，例如 1GB
`.trim());
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
