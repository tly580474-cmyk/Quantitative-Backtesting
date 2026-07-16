import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { DuckDBValue } from '@duckdb/node-api';
import { writeTextOutputAtomic } from './researchOutput.js';
import { sha256File } from './snapshotManifest.js';

export interface ArtifactSnapshotContext {
  snapshotId: string;
  sourceVersion: string;
  sourcePublishedAt: string | null;
}

export interface ArtifactQuery {
  id: string;
  sql: string;
  source?: string;
}

export interface ArtifactOutput {
  id: string;
  path: string;
  format: string;
  rows: number | null;
}

interface ArtifactFile {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface ResearchArtifactManifestInput {
  command: 'query' | 'recipe' | 'minute' | 'pipeline' | 'batch';
  name: string;
  sourcePath: string | null;
  status: 'validated' | 'failed';
  startedAt: string;
  completedAt: string;
  snapshot: ArtifactSnapshotContext | null;
  minuteRoot: string;
  parameters: Record<string, DuckDBValue>;
  queries: ArtifactQuery[];
  outputs: ArtifactOutput[];
  error?: string;
}

export async function writeResearchArtifactManifest(
  manifestPathInput: string,
  input: ResearchArtifactManifestInput,
): Promise<string> {
  const manifestPath = resolve(manifestPathInput);
  const minute = await readMinuteManifest(input.minuteRoot);
  const outputs = await Promise.all(input.outputs.map(async (output) => {
    const files = await describeOutputFiles(output.path);
    const aggregate = createHash('sha256');
    for (const file of files) {
      aggregate.update(`${file.relativePath}|${file.bytes}|${file.sha256}\n`);
    }
    return {
      ...output,
      path: resolve(output.path),
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      sha256: aggregate.digest('hex'),
      files,
    };
  }));
  const payload = {
    schemaVersion: 1,
    runId: randomUUID(),
    command: input.command,
    name: input.name,
    sourcePath: input.sourcePath ? resolve(input.sourcePath) : null,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    snapshot: input.snapshot,
    minute,
    parameters: jsonSafe(input.parameters),
    queries: input.queries.map((query) => ({
      id: query.id,
      source: query.source ? resolve(query.source) : null,
      sha256: sha256Text(query.sql),
    })),
    outputs,
    error: input.error ?? null,
  };
  return writeTextOutputAtomic(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function defaultArtifactManifestPath(
  outputRoot: string,
  sourcePath: string,
  explicitName?: string,
): string {
  const stem = sanitizeFileName(explicitName?.trim() || basename(sourcePath).replace(/\.[^.]+$/, ''));
  return resolve(outputRoot, `${stem}.manifest.json`);
}

async function readMinuteManifest(rootInput: string): Promise<{
  root: string;
  dataset: string | null;
  preparedAt: string | null;
  startYear: number | null;
  endYear: number | null;
  firstDate: string | null;
  lastDate: string | null;
  tradingDays: number | null;
  fileCount: number | null;
  sha256: string;
} | null> {
  const root = resolve(rootInput);
  const path = join(root, 'manifest.json');
  try {
    const [content, checksum] = await Promise.all([readFile(path, 'utf8'), sha256File(path)]);
    const value = JSON.parse(content) as Record<string, unknown>;
    const years = Array.isArray(value.years)
      ? value.years as Record<string, unknown>[]
      : [];
    const firstDate = text(value.firstDate)
      ?? years.map((year) => text(year.firstDate)).filter((item): item is string => item !== null).sort()[0]
      ?? null;
    const lastDates = years
      .map((year) => text(year.lastDate))
      .filter((item): item is string => item !== null)
      .sort();
    const fileCount = numberOrNull(value.tradingDays)
      ?? (years.length > 0
        ? years.reduce((sum, year) => sum + (numberOrNull(year.fileCount) ?? 0), 0)
        : null);
    return {
      root,
      dataset: text(value.dataset),
      preparedAt: text(value.preparedAt),
      startYear: numberOrNull(value.startYear),
      endYear: numberOrNull(value.endYear),
      firstDate,
      lastDate: text(value.lastDate) ?? lastDates.at(-1) ?? null,
      tradingDays: numberOrNull(value.tradingDays) ?? fileCount,
      fileCount,
      sha256: checksum,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function describeOutputFiles(pathInput: string): Promise<ArtifactFile[]> {
  const root = resolve(pathInput);
  const info = await stat(root);
  if (info.isFile()) {
    return [{
      relativePath: basename(root),
      bytes: info.size,
      sha256: await sha256File(root),
    }];
  }
  if (!info.isDirectory()) throw new Error(`研究产物不是文件或目录：${root}`);
  const paths = await listFiles(root);
  return Promise.all(paths.map(async (path) => {
    const fileInfo = await stat(path);
    return {
      relativePath: relative(root, path).replaceAll('\\', '/'),
      bytes: fileInfo.size,
      sha256: await sha256File(path),
    };
  }));
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else if (entry.isFile() && !entry.name.endsWith('.partial')) result.push(path);
  }
  return result.sort();
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_') || 'research-artifact';
}
