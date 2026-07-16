import { resolve } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { inferOutputFormat, splitSqlStatements, type OutputFormat, type ParameterMap } from './duckdbCliSupport.js';
import {
  createStagedOutput,
  discardStagedOutput,
  finalizeStagedOutput,
} from './researchOutput.js';

export interface DuckDBExportResult {
  path: string;
  rows: number | null;
  format: 'csv' | 'parquet';
}

export function supportsDirectDuckDBExport(path: string, fallback: OutputFormat): boolean {
  const format = inferOutputFormat(path, fallback);
  return format === 'csv' || format === 'parquet';
}

export async function exportSqlScript(
  connection: DuckDBConnection,
  sql: string,
  params: ParameterMap,
  pathInput: string,
  fallbackFormat: OutputFormat,
  echoSql = false,
  transaction = false,
  partitionBy: string[] = [],
): Promise<DuckDBExportResult> {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) throw new Error('SQL 为空');
  const path = resolve(pathInput);
  const format = inferOutputFormat(path, fallbackFormat);
  if (format !== 'csv' && format !== 'parquet') {
    throw new Error(`DuckDB COPY 不支持 ${format} 格式`);
  }
  if (partitionBy.length > 0 && format !== 'parquet') {
    throw new Error('partitionBy 仅支持 Parquet 导出');
  }
  for (const column of partitionBy) assertIdentifier(column);
  const staged = await createStagedOutput(path, partitionBy.length > 0);

  if (transaction) await connection.run('BEGIN TRANSACTION');
  try {
    for (let index = 0; index < statements.length - 1; index += 1) {
      const statement = statements[index];
      if (echoSql) console.error(`[sql ${index + 1}/${statements.length}]\n${statement}`);
      await connection.run(statement, parametersForSql(statement, params));
    }

    const query = statements.at(-1)!;
    const copySql = buildCopySql(query, staged.stagingPath, format, partitionBy);
    if (echoSql) console.error(`[copy ${statements.length}/${statements.length}]\n${copySql}`);
    const reader = await connection.runAndReadAll(copySql, parametersForSql(query, params));
    const row = reader.getRowObjectsJson()[0] as Record<string, unknown> | undefined;
    if (transaction) await connection.run('COMMIT');
    const finalPath = await finalizeStagedOutput(staged);
    return {
      path: finalPath,
      rows: extractCopiedRows(row),
      format,
    };
  } catch (error) {
    if (transaction) await connection.run('ROLLBACK').catch(() => undefined);
    await discardStagedOutput(staged);
    throw error;
  }
}

function buildCopySql(
  query: string,
  path: string,
  format: 'csv' | 'parquet',
  partitionBy: string[],
): string {
  const target = escapeSqlLiteral(normalizeDuckDbPath(path));
  const options = format === 'csv'
    ? "FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', ESCAPE '\"'"
    : [
        'FORMAT PARQUET',
        'COMPRESSION ZSTD',
        ...(partitionBy.length > 0
          ? [`PARTITION_BY (${partitionBy.map(quoteIdentifier).join(', ')}), OVERWRITE_OR_IGNORE true`]
          : []),
      ].join(', ');
  return `COPY (${query}) TO '${target}' (${options})`;
}

function parametersForSql(sql: string, params: ParameterMap): ParameterMap {
  const names = new Set(
    [...sql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((match) => match[1]),
  );
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => names.has(key)),
  ) as ParameterMap;
}

function extractCopiedRows(row: Record<string, unknown> | undefined): number | null {
  if (!row) return null;
  for (const [key, value] of Object.entries(row)) {
    if (/count|rows/i.test(key) && value != null && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function normalizeDuckDbPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`无效的 partitionBy 列名：${value}`);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
