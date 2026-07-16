import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import type { DuckDBValue } from '@duckdb/node-api';

export type OutputFormat = 'table' | 'json' | 'csv';
export type ParameterMap = Record<string, DuckDBValue>;

export interface WorkflowStep {
  id: string;
  sql?: string;
  file?: string;
  params?: Record<string, unknown>;
  out?: string;
  splitBy?: string;
  format?: OutputFormat;
  print?: boolean;
}

export interface WorkflowFile {
  version: 1;
  name?: string;
  params?: Record<string, unknown>;
  transaction?: boolean;
  steps: WorkflowStep[];
}

export interface BatchJob {
  id: string;
  sql?: string;
  file?: string;
  params?: Record<string, unknown>;
  out?: string;
  format?: OutputFormat;
}

export interface BatchFile {
  version: 1;
  name?: string;
  sql?: string;
  file?: string;
  params?: Record<string, unknown>;
  out?: string;
  format?: OutputFormat;
  transaction?: boolean;
  jobs: BatchJob[];
}

export class ArgReader {
  constructor(private readonly args: string[]) {}

  has(name: string): boolean {
    return this.args.includes(name);
  }

  value(...names: string[]): string | undefined {
    for (const name of names) {
      const index = this.args.indexOf(name);
      if (index >= 0) return this.args[index + 1];
    }
    return undefined;
  }

  values(...names: string[]): string[] {
    const result: string[] = [];
    for (let index = 0; index < this.args.length; index += 1) {
      if (names.includes(this.args[index]) && this.args[index + 1] !== undefined) {
        result.push(this.args[index + 1]);
        index += 1;
      }
    }
    return result;
  }
}

export async function loadCliParameters(
  assignments: string[],
  paramsFile?: string,
): Promise<ParameterMap> {
  const fromFile = paramsFile
    ? normalizeParameterObject(JSON.parse(await readFile(resolve(paramsFile), 'utf8')))
    : {};
  return { ...fromFile, ...parseParameterAssignments(assignments) };
}

export function parseParameterAssignments(assignments: string[]): ParameterMap {
  const result: ParameterMap = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) throw new Error(`参数格式无效：${assignment}，应使用 name=value`);
    const key = assignment.slice(0, separator).trim();
    const raw = assignment.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`参数名无效：${key}`);
    result[key] = parseScalarValue(raw);
  }
  return result;
}

export function normalizeParameterObject(value: unknown): ParameterMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('参数文件必须是 JSON 对象');
  }
  const result: ParameterMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`参数名无效：${key}`);
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      result[key] = item;
      continue;
    }
    throw new Error(`参数 ${key} 仅支持 string、number、boolean 或 null`);
  }
  return result;
}

export async function readWorkflowFile(pathInput: string): Promise<WorkflowFile> {
  const path = resolve(pathInput);
  const value = JSON.parse(await readFile(path, 'utf8')) as WorkflowFile;
  if (value.version !== 1 || !Array.isArray(value.steps) || value.steps.length === 0) {
    throw new Error('pipeline 文件必须包含 version=1 和非空 steps');
  }
  const ids = new Set<string>();
  for (const step of value.steps) {
    validateExecutable(step, 'pipeline step');
    if (!step.id?.trim() || ids.has(step.id)) throw new Error(`pipeline step id 无效或重复：${step.id}`);
    ids.add(step.id);
    if (step.format && !isOutputFormat(step.format)) throw new Error(`不支持的输出格式：${step.format}`);
    if (step.splitBy) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.splitBy)) {
        throw new Error(`pipeline step ${step.id} splitBy 列名无效：${step.splitBy}`);
      }
      if (!step.out) throw new Error(`pipeline step ${step.id} 使用 splitBy 时必须配置 out`);
      if (!step.out.includes(`\${${step.splitBy}}`)) {
        throw new Error(
          `pipeline step ${step.id} 的 out 必须包含 \${${step.splitBy}} 路径变量`,
        );
      }
    }
  }
  return value;
}

export async function readBatchFile(pathInput: string): Promise<BatchFile> {
  const value = JSON.parse(await readFile(resolve(pathInput), 'utf8')) as BatchFile;
  if (value.version !== 1 || !Array.isArray(value.jobs) || value.jobs.length === 0) {
    throw new Error('batch 文件必须包含 version=1 和非空 jobs');
  }
  if (!value.sql && !value.file && value.jobs.some((job) => !job.sql && !job.file)) {
    throw new Error('batch 顶层或每个 job 必须提供 sql/file');
  }
  if (value.sql && value.file) throw new Error('batch 顶层不能同时设置 sql 和 file');
  const ids = new Set<string>();
  for (const job of value.jobs) {
    if (!job.id?.trim() || ids.has(job.id)) throw new Error(`batch job id 无效或重复：${job.id}`);
    ids.add(job.id);
    if (job.sql && job.file) throw new Error(`batch job ${job.id} 不能同时设置 sql 和 file`);
    if (job.format && !isOutputFormat(job.format)) throw new Error(`不支持的输出格式：${job.format}`);
  }
  return value;
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  let dollarTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (dollarTag) {
      current += char;
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag.slice(1);
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '$') {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export function resolveTemplate(value: string, params: ParameterMap): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    const replacement = params[key];
    if (replacement === undefined || replacement === null) {
      throw new Error(`输出路径模板缺少参数：${key}`);
    }
    return sanitizePathSegment(String(replacement));
  });
}

export function groupRowsByColumn(
  rows: Record<string, unknown>[],
  column: string,
): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    if (!(column in row)) throw new Error(`splitBy 列 ${column} 不存在于查询结果中`);
    const rawValue = row[column];
    const value = rawValue === null || rawValue === undefined ? 'null' : String(rawValue);
    const group = groups.get(value);
    if (group) group.push(row);
    else groups.set(value, [row]);
  }
  return groups;
}

export async function writeRows(
  rows: Record<string, unknown>[],
  pathInput: string,
  fallbackFormat: OutputFormat,
): Promise<string> {
  const path = resolve(pathInput);
  const format = inferOutputFormat(path, fallbackFormat);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatRows(rows, format), 'utf8');
  return path;
}

export function formatRows(rows: Record<string, unknown>[], format: OutputFormat): string {
  if (format === 'json') return `${JSON.stringify(rows, null, 2)}\n`;
  if (format === 'csv') return toCsv(rows);
  return toTable(rows);
}

export function isOutputFormat(value: string): value is OutputFormat {
  return value === 'table' || value === 'json' || value === 'csv';
}

export function inferOutputFormat(path: string, fallback: OutputFormat): OutputFormat {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.csv') return 'csv';
  return fallback;
}

function validateExecutable(value: { sql?: string; file?: string }, label: string): void {
  if ((!value.sql && !value.file) || (value.sql && value.file)) {
    throw new Error(`${label} 必须且只能设置 sql 或 file`);
  }
}

function parseScalarValue(raw: string): DuckDBValue {
  const trimmed = raw.trim();
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  return raw;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

function toCsv(rows: Record<string, unknown>[]): string {
  const columns = collectColumns(rows);
  if (columns.length === 0) return '';
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
  const widths = columns.map((column, index) => Math.min(80, Math.max(
    displayWidth(column),
    ...textRows.map((row) => displayWidth(row[index])),
  )));
  const separator = widths.map((width) => '-'.repeat(width)).join('-+-');
  const header = columns.map((column, index) => padCell(column, widths[index])).join(' | ');
  const body = textRows
    .map((row) => row.map((cell, index) => padCell(cell, widths[index])).join(' | '))
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

function displayWidth(value: string): number {
  return [...value].reduce((sum, char) => sum + (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(char) ? 2 : 1), 0);
}

function padCell(value: string, width: number): string {
  const truncated = truncateCell(value, width);
  return truncated + ' '.repeat(Math.max(0, width - displayWidth(truncated)));
}

function truncateCell(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  let result = '';
  for (const char of value) {
    if (displayWidth(`${result}${char}…`) > width) break;
    result += char;
  }
  return `${result}…`;
}
