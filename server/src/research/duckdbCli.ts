import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { loadConfig } from '../config.js';
import { readCurrentSnapshot } from './snapshotManifest.js';
import {
  ArgReader,
  formatRows,
  groupRowsByColumn,
  inferOutputFormat,
  isOutputFormat,
  loadCliParameters,
  normalizeParameterObject,
  readBatchFile,
  readWorkflowFile,
  resolveTemplate,
  splitSqlStatements,
  writeRows,
  type OutputFormat,
  type ParameterMap,
} from './duckdbCliSupport.js';
import {
  buildRecipe,
  listRecipeFactors,
  listRecipes,
  type RecipeName,
  type RecipeOptions,
} from './duckdbRecipes.js';
import { buildMinuteQuery } from './duckdbMinuteQuery.js';

type Command =
  | 'help'
  | 'status'
  | 'schema'
  | 'views'
  | 'query'
  | 'pipeline'
  | 'batch'
  | 'minute'
  | 'recipes'
  | 'recipe';

interface CliArgs {
  command: Command;
  recipeName?: RecipeName;
  db: string;
  snapshotRoot: string;
  sql?: string;
  file?: string;
  out?: string;
  outDir?: string;
  format: OutputFormat;
  noSnapshotView: boolean;
  threads?: string;
  maxMemory?: string;
  params: string[];
  paramsFile?: string;
  transaction: boolean;
  dryRun: boolean;
  echoSql: boolean;
  explain: boolean;
  continueOnError: boolean;
  view?: string;
  recipeOptions: RecipeOptions;
  listFactors: boolean;
  minuteRoot: string;
  minuteInterval?: string;
  minuteDays?: string;
  includeAuction: boolean;
  splitBySymbol: boolean;
}

interface SnapshotContext {
  snapshotId: string;
  parquetGlob: string;
  views: string[];
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(
    process.argv.slice(2),
    config.RESEARCH_SNAPSHOT_ROOT,
    config.MINUTE_DATA_ROOT,
  );

  if (args.command === 'help') {
    printHelp();
    return;
  }
  if (args.command === 'recipes') {
    await outputRows(args.listFactors ? listRecipeFactors() : listRecipes(), args);
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
            datasets: current.manifest.datasets?.length ?? 0,
          }]
        : [{ status: 'unavailable', snapshotRoot: resolve(args.snapshotRoot) }],
      args,
    );
    return;
  }

  const instance = await DuckDBInstance.create(args.db, {
    access_mode: 'READ_WRITE',
    threads: args.threads ?? '4',
    ...(args.maxMemory ? { max_memory: args.maxMemory } : {}),
  });
  const connection = await instance.connect();
  try {
    const snapshot = args.noSnapshotView || args.command === 'minute'
      ? null
      : await registerSnapshotViews(connection, args.snapshotRoot);

    if (args.command === 'views') {
      const reader = await connection.runAndReadAll('SHOW TABLES');
      await outputRows(reader.getRowObjectsJson() as Record<string, unknown>[], args);
      return;
    }
    if (args.command === 'schema') {
      const view = args.view ?? 'bars';
      if (!snapshot && view === 'bars') {
        throw new Error('尚未发布可用的研究快照，无法查看 bars 视图结构');
      }
      assertIdentifier(view, 'view');
      const reader = await connection.runAndReadAll(`DESCRIBE ${view}`);
      await outputRows(reader.getRowObjectsJson() as Record<string, unknown>[], args);
      return;
    }

    const cliParams = await loadCliParameters(args.params, args.paramsFile);
    if (args.command === 'minute') {
      const minuteQuery = buildMinuteQuery({
        minuteRoot: args.minuteRoot,
        symbols: args.recipeOptions.symbols,
        startDate: args.recipeOptions.startDate,
        endDate: args.recipeOptions.endDate,
        days: args.minuteDays,
        interval: args.minuteInterval,
        includeAuction: args.includeAuction,
      });
      const params = { ...minuteQuery.params, ...cliParams };
      if (args.dryRun) {
        console.error(
          `分钟聚合：${minuteQuery.symbols.join(', ')}，${minuteQuery.startDate} 至 ${minuteQuery.endDate}，${minuteQuery.intervalMinutes}m`,
        );
        printSql(minuteQuery.sql, params);
        return;
      }
      const rows = await executeSqlScript(
        connection,
        minuteQuery.sql,
        params,
        args.transaction,
        args.echoSql,
      );
      if (args.splitBySymbol) {
        const outDir = resolve(args.outDir ?? './out');
        for (const symbol of minuteQuery.symbols) {
          const symbolRows = rows.filter((row) => String(row.code) === symbol);
          const fileName = `${symbol.replace('.', '-')}-${minuteQuery.intervalMinutes}m-${minuteQuery.startDate}-${minuteQuery.endDate}.csv`;
          const path = await writeRows(symbolRows, join(outDir, fileName), 'csv');
          console.error(`已写入 ${path} (${symbolRows.length} rows)`);
        }
      } else {
        await outputRows(rows, args);
      }
      return;
    }
    if (args.command === 'query') {
      const sql = await loadQuerySql(args, snapshot);
      const executableSql = args.explain ? explainSql(sql) : sql;
      if (args.dryRun) {
        printSql(executableSql, cliParams);
        return;
      }
      const rows = await executeSqlScript(
        connection,
        executableSql,
        cliParams,
        args.transaction,
        args.echoSql,
      );
      await outputRows(rows, args);
      return;
    }
    if (args.command === 'recipe') {
      const recipe = buildRecipe(args.recipeName!, args.recipeOptions);
      const params = { ...recipe.params, ...cliParams };
      if (args.dryRun) {
        console.error(recipe.description);
        printSql(recipe.sql, params);
        return;
      }
      const rows = await executeSqlScript(connection, recipe.sql, params, args.transaction, args.echoSql);
      await outputRows(rows, args);
      return;
    }
    if (args.command === 'pipeline') {
      if (!args.file) throw new Error('pipeline 必须使用 --file 指定 JSON 工作流');
      await runPipeline(connection, args, cliParams);
      return;
    }
    if (args.command === 'batch') {
      if (!args.file) throw new Error('batch 必须使用 --file 指定 JSON 批处理文件');
      await runBatch(connection, args, cliParams);
      return;
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function runPipeline(
  connection: DuckDBConnection,
  args: CliArgs,
  cliParams: ParameterMap,
): Promise<void> {
  const workflowPath = resolve(args.file!);
  const workflow = await readWorkflowFile(workflowPath);
  const baseDir = dirname(workflowPath);
  const workflowParams = workflow.params ? normalizeParameterObject(workflow.params) : {};
  const globalParams = { ...workflowParams, ...cliParams };
  if (args.dryRun) console.error(`pipeline: ${workflow.name ?? workflowPath}`);
  if ((workflow.transaction || args.transaction) && !args.dryRun) {
    await connection.run('BEGIN TRANSACTION');
  }
  try {
    for (let index = 0; index < workflow.steps.length; index += 1) {
      const step = workflow.steps[index];
      const params = {
        ...globalParams,
        ...(step.params ? normalizeParameterObject(step.params) : {}),
      };
      const sql = step.sql ?? await readFile(resolve(baseDir, step.file!), 'utf8');
      console.error(`[pipeline ${index + 1}/${workflow.steps.length}] ${step.id}`);
      if (args.dryRun) {
        printSql(sql, params);
        continue;
      }
      const rows = await executeSqlScript(connection, sql, params, false, args.echoSql);
      if (step.out) {
        if (step.splitBy) {
          const groups = groupRowsByColumn(rows, step.splitBy);
          for (const [value, groupRows] of groups) {
            const out = resolveOutputPath(
              baseDir,
              args.outDir,
              resolveTemplate(step.out, { ...params, [step.splitBy]: value }),
            );
            await writeRows(groupRows, out, step.format ?? args.format);
          }
          console.error(
            `  已按 ${step.splitBy} 拆分写入 ${groups.size} 个文件 (${rows.length} rows)`,
          );
        } else {
          const out = resolveOutputPath(baseDir, args.outDir, resolveTemplate(step.out, params));
          const path = await writeRows(rows, out, step.format ?? args.format);
          console.error(`  已写入 ${path} (${rows.length} rows)`);
        }
      }
      if (step.print || (!step.out && index === workflow.steps.length - 1)) {
        console.log(formatRows(rows, step.format ?? args.format));
      }
    }
    if ((workflow.transaction || args.transaction) && !args.dryRun) await connection.run('COMMIT');
  } catch (error) {
    if ((workflow.transaction || args.transaction) && !args.dryRun) {
      await connection.run('ROLLBACK').catch(() => undefined);
    }
    throw error;
  }
}

async function runBatch(
  connection: DuckDBConnection,
  args: CliArgs,
  cliParams: ParameterMap,
): Promise<void> {
  const batchPath = resolve(args.file!);
  const batch = await readBatchFile(batchPath);
  const baseDir = dirname(batchPath);
  const batchParams = batch.params ? normalizeParameterObject(batch.params) : {};
  const globalParams = { ...batchParams, ...cliParams };
  if ((batch.transaction || args.transaction) && args.continueOnError) {
    throw new Error('transaction 与 continue-on-error 不能同时使用');
  }
  if ((batch.transaction || args.transaction) && !args.dryRun) {
    await connection.run('BEGIN TRANSACTION');
  }
  let failures = 0;
  try {
    for (let index = 0; index < batch.jobs.length; index += 1) {
      const job = batch.jobs[index];
      const params = {
        ...globalParams,
        ...(job.params ? normalizeParameterObject(job.params) : {}),
      };
      const sqlText = job.sql ?? batch.sql;
      const fileText = job.file ?? batch.file;
      const sql = sqlText ?? await readFile(resolve(baseDir, fileText!), 'utf8');
      console.error(`[batch ${index + 1}/${batch.jobs.length}] ${job.id}`);
      if (args.dryRun) {
        printSql(sql, params);
        continue;
      }
      try {
        const rows = await executeSqlScript(connection, sql, params, false, args.echoSql);
        const outTemplate = job.out ?? batch.out;
        if (outTemplate) {
          const templatedParams = { ...params, job: job.id };
          const out = resolveOutputPath(baseDir, args.outDir, resolveTemplate(outTemplate, templatedParams));
          const path = await writeRows(rows, out, job.format ?? batch.format ?? args.format);
          console.error(`  已写入 ${path} (${rows.length} rows)`);
        } else {
          console.log(formatRows(rows, job.format ?? batch.format ?? args.format));
        }
      } catch (error) {
        failures += 1;
        console.error(`  失败：${error instanceof Error ? error.message : String(error)}`);
        if (!args.continueOnError) throw error;
      }
    }
    if ((batch.transaction || args.transaction) && !args.dryRun) await connection.run('COMMIT');
  } catch (error) {
    if ((batch.transaction || args.transaction) && !args.dryRun) {
      await connection.run('ROLLBACK').catch(() => undefined);
    }
    throw error;
  }
  if (failures > 0) throw new Error(`batch 完成，但有 ${failures} 个 job 失败`);
}

async function executeSqlScript(
  connection: DuckDBConnection,
  sql: string,
  params: ParameterMap,
  transaction: boolean,
  echoSql: boolean,
): Promise<Record<string, unknown>[]> {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) throw new Error('SQL 为空');
  if (transaction) await connection.run('BEGIN TRANSACTION');
  let rows: Record<string, unknown>[] = [];
  try {
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      if (echoSql) console.error(`[sql ${index + 1}/${statements.length}]\n${statement}`);
      const reader = await connection.runAndReadAll(statement, parametersForSql(statement, params));
      rows = reader.getRowObjectsJson() as Record<string, unknown>[];
    }
    if (transaction) await connection.run('COMMIT');
    return rows;
  } catch (error) {
    if (transaction) await connection.run('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function parametersForSql(sql: string, params: ParameterMap): ParameterMap {
  const names = new Set(
    [...sql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((match) => match[1]),
  );
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => names.has(key)),
  ) as ParameterMap;
}

async function registerSnapshotViews(
  connection: DuckDBConnection,
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
  const views = ['bars'];
  await connection.run(`
    CREATE OR REPLACE VIEW stock_valuations AS
    SELECT instrumentKey, market, symbol, name, tradeDate, close,
           totalMarketCap, floatMarketCap, peTtm, pb, psTtm
    FROM bars
  `);
  views.push('stock_valuations');
  for (const [datasetName, viewName] of [
    ['adjustment_factors', 'adjustment_factors'],
    ['index_bars', 'index_bars'],
    ['index_constituent_snapshots', 'index_constituent_snapshots'],
    ['dividend_events', 'dividend_events'],
    ['sw_industry_definitions', 'sw_industry_definitions'],
    ['sw_industry_memberships', 'sw_industry_memberships'],
    ['sw_industry_bars', 'sw_industry_bars'],
  ] as const) {
    const dataset = current.manifest.datasets?.find((item) => item.name === datasetName);
    if (!dataset) continue;
    const path = normalizeDuckDbPath(
      join(snapshotRoot, current.manifest.snapshotId, dataset.relativePath),
    );
    await connection.run(`
      CREATE OR REPLACE VIEW ${viewName} AS
      SELECT * FROM read_parquet('${escapeSqlLiteral(path)}')
    `);
    views.push(viewName);
  }
  const constituents = current.manifest.datasets?.find((item) => item.name === 'index_constituents');
  if (constituents) {
    const path = normalizeDuckDbPath(
      join(snapshotRoot, current.manifest.snapshotId, constituents.relativePath),
    );
    await connection.run(`
      CREATE OR REPLACE VIEW index_constituents AS
      SELECT * FROM read_parquet('${escapeSqlLiteral(path)}');

      CREATE OR REPLACE VIEW index_constituents_scd AS
      WITH versions AS (
        SELECT snapshotId, indexCode, sourceKey, constituentDate AS effectiveFrom,
               LEAD(constituentDate) OVER (
                 PARTITION BY indexCode, sourceKey ORDER BY constituentDate, snapshotId
               ) AS nextEffectiveFrom
        FROM index_constituent_snapshots
      )
      SELECT member.*,
             version.effectiveFrom,
             version.nextEffectiveFrom - INTERVAL 1 DAY AS effectiveTo
      FROM index_constituents AS member
      INNER JOIN versions AS version USING (snapshotId, indexCode, sourceKey)
    `);
    views.push('index_constituents', 'index_constituents_scd');
  }
  return { snapshotId: current.manifest.snapshotId, parquetGlob, views };
}

async function loadQuerySql(args: CliArgs, snapshot: SnapshotContext | null): Promise<string> {
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
  if (args.out) {
    const path = await writeRows(rows, args.out, args.format);
    console.error(`已写入 ${path} (${rows.length} rows)`);
    return;
  }
  console.log(formatRows(rows, args.format));
}

function parseArgs(
  rawArgs: string[],
  defaultSnapshotRoot: string,
  defaultMinuteRoot: string,
): CliArgs {
  const command = normalizeCommand(rawArgs[0]);
  let optionArgs = rawArgs.slice(1);
  let recipeName: RecipeName | undefined;
  if (command === 'recipe') {
    recipeName = normalizeRecipeName(optionArgs[0]);
    optionArgs = optionArgs.slice(1);
  }
  const reader = new ArgReader(optionArgs);
  const format = reader.value('--format', '-f')
    ?? (reader.value('--out', '-o') ? inferOutputFormat(reader.value('--out', '-o')!, 'table') : 'table');
  if (!isOutputFormat(format)) throw new Error(`不支持的输出格式：${format}`);
  return {
    command,
    recipeName,
    db: reader.value('--db') ?? ':memory:',
    snapshotRoot: reader.value('--snapshot-root') ?? defaultSnapshotRoot,
    sql: reader.value('--sql', '-q'),
    file: reader.value('--file'),
    out: reader.value('--out', '-o'),
    outDir: reader.value('--out-dir'),
    format,
    noSnapshotView: reader.has('--no-snapshot-view'),
    threads: reader.value('--threads'),
    maxMemory: reader.value('--max-memory'),
    params: reader.values('--param', '-p'),
    paramsFile: reader.value('--params-file'),
    transaction: reader.has('--transaction'),
    dryRun: reader.has('--dry-run'),
    echoSql: reader.has('--echo-sql'),
    explain: reader.has('--explain'),
    continueOnError: reader.has('--continue-on-error'),
    view: reader.value('--view'),
    listFactors: reader.has('--factors'),
    minuteRoot: reader.value('--minute-root') ?? defaultMinuteRoot,
    minuteInterval: reader.value('--interval'),
    minuteDays: reader.value('--days'),
    includeAuction: reader.has('--include-auction'),
    splitBySymbol: reader.has('--split-by-symbol'),
    recipeOptions: {
      factors: reader.values('--factor'),
      weights: reader.values('--weight'),
      markets: splitListValues(reader.values('--market')),
      symbols: splitListValues(reader.values('--symbol')),
      where: reader.values('--where'),
      startDate: reader.value('--start'),
      endDate: reader.value('--end'),
      date: reader.value('--date'),
      top: reader.value('--top', '--limit'),
      minAmount: reader.value('--min-amount'),
      horizon: reader.value('--horizon'),
      layers: reader.value('--layers'),
      period: reader.value('--period'),
      rollingWindow: reader.value('--rolling-window'),
    },
  };
}

function normalizeCommand(value: string | undefined): Command {
  if (!value || value === '--help' || value === '-h' || value === 'help') return 'help';
  if (value === 'current') return 'status';
  if (value === 'fields' || value === 'columns') return 'schema';
  if (value === 'sql') return 'query';
  if (['status', 'schema', 'views', 'query', 'pipeline', 'batch', 'minute', 'recipes', 'recipe'].includes(value)) {
    return value as Command;
  }
  throw new Error(`未知命令：${value}`);
}

function normalizeRecipeName(value: string | undefined): RecipeName {
  if (value === 'factor-screen' || value === 'factor-layer' || value === 'timeseries') return value;
  throw new Error(`未知 recipe：${value ?? ''}，可使用 recipes 查看`);
}

function explainSql(sql: string): string {
  const statements = splitSqlStatements(sql);
  if (statements.length !== 1) throw new Error('--explain 仅支持单条 SQL');
  return `EXPLAIN ANALYZE ${statements[0]}`;
}

function printSql(sql: string, params: ParameterMap): void {
  console.log(sql.trim());
  console.error(`params: ${JSON.stringify(params, bigintJsonReplacer, 2)}`);
}

function bigintJsonReplacer(_key: string, value: DuckDBValue): DuckDBValue | string {
  return typeof value === 'bigint' ? value.toString() : value;
}

function resolveOutputPath(baseDir: string, outDir: string | undefined, path: string): string {
  if (outDir) return resolve(outDir, path);
  return resolve(baseDir, path);
}

function splitListValues(values: string[]): string[] {
  return values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${label} 名称无效：${value}`);
}

function normalizeDuckDbPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function printHelp(): void {
  console.log(`
本地 DuckDB 量化研究 CLI

基础命令：
  npm run duckdb -- status
  npm run duckdb -- views
  npm run duckdb -- schema --view bars
  npm run duckdb -- query --sql "SELECT * FROM bars WHERE symbol=$symbol" --param symbol=002155
  npm run duckdb -- query --file ./query.sql --params-file ./params.json --transaction

多步骤与批处理：
  npm run duckdb -- pipeline --file ./pipelines/factor-study.json --param startDate=2025-01-01
  npm run duckdb -- batch --file ./batches/export-symbols.json --out-dir ./out

分钟行情聚合：
  npm run duckdb -- minute --symbol 688656 --symbol 601899 --days 30 --interval 5m --out ./out/minute-5m.csv
  npm run duckdb -- minute --symbol 688656,601899 --start 2026-06-16 --end 2026-07-16 --interval 5m --split-by-symbol --out-dir ./out

量化研究 recipe：
  npm run duckdb -- recipes
  npm run duckdb -- recipes --factors
  npm run duckdb -- recipe factor-screen --factor momentum_20 --factor volume_ratio_20 --top 50
  npm run duckdb -- recipe factor-layer --factor momentum_20 --start 2025-01-01 --end 2026-06-30 --horizon 5 --layers 5
  npm run duckdb -- recipe timeseries --symbol 002155 --period month --rolling-window 6

通用参数：
  --param, -p name=value   可重复；自动识别 number、boolean、null
  --params-file            JSON 参数对象，命令行参数优先
  --out, -o                单结果输出文件
  --out-dir                pipeline/batch 多文件输出根目录
  --format, -f             table | json | csv
  --transaction            在事务中执行 SQL 文件或整个 pipeline/batch
  --dry-run                只显示 SQL、步骤和参数，不执行
  --echo-sql               执行时打印每条 SQL
  --explain                对单条 query 执行 EXPLAIN ANALYZE
  --continue-on-error      batch 中单个 job 失败后继续
  --db                     DuckDB 数据库路径，默认 :memory:
  --snapshot-root          研究快照目录
  --no-snapshot-view       不挂载研究快照视图
  --threads                DuckDB 线程数，默认 4
  --max-memory             DuckDB 内存上限，例如 2GB

minute 参数：
  --symbol                 6 位股票代码或带交易所后缀，可重复/逗号分隔
  --start / --end          日期范围；未传 start 时默认使用 --days
  --days                   最近自然日数量，默认 30
  --interval               1m|5m|10m|15m|30m|60m|120m，默认 5m
  --minute-root            分钟 Parquet 湖目录，默认读取 MINUTE_DATA_ROOT
  --include-auction        保留旧数据源中的 09:30 集合竞价分钟
  --split-by-symbol        每只股票生成一个 CSV，配合 --out-dir

recipe 参数：
  --factor                 内置因子 ID，可重复
  --weight factor=number   多因子权重，可重复
  --market / --symbol      可重复或使用逗号分隔
  --start / --end / --date 日期范围或筛选截面
  --where                  追加高级 SQL 条件，可重复
  --min-amount             最低成交额
  --top                    factor-screen 返回数量
  --horizon / --layers     factor-layer 持有期和分层数
  --period                 timeseries 的 week|month|quarter|year
  --rolling-window         聚合后的滚动均线周期
`.trim());
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
