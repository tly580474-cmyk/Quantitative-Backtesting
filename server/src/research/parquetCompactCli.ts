import 'dotenv/config';
import { resolve } from 'node:path';
import { exportSqlScript } from './duckdbExport.js';
import { openManagedDuckDB } from './duckdbRuntime.js';

const args = process.argv.slice(2);
const values = (name: string) => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) result.push(args[++index]);
  }
  return result;
};
const value = (name: string) => values(name)[0];
const inputs = values('--input');
const output = value('--out');
const partitionBy = values('--partition-by')
  .flatMap((item) => item.split(','))
  .map((item) => item.trim())
  .filter(Boolean);
if (inputs.length === 0 || !output) {
  throw new Error('用法：npm run parquet:compact -- --input <glob> [--input <glob>] --out <path> [--partition-by tradeDate]');
}
const paths = inputs.map((item) => `'${escapeSqlLiteral(normalizePath(resolve(item)))}'`).join(',');
const sql = `SELECT * FROM read_parquet([${paths}], union_by_name=true)`;
const session = await openManagedDuckDB({
  label: 'parquet-compact',
  config: {
    threads: value('--threads') ?? '4',
    ...(value('--max-memory') ? { max_memory: value('--max-memory')! } : {}),
  },
});
try {
  const result = await exportSqlScript(
    session.connection,
    sql,
    {},
    output,
    'parquet',
    args.includes('--echo-sql'),
    false,
    partitionBy,
  );
  console.log(JSON.stringify({
    inputs: inputs.map((item) => resolve(item)),
    output: result.path,
    rows: result.rows,
    partitionBy,
  }, null, 2));
} finally {
  await session.close();
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
