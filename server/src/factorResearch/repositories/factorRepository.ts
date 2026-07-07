import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { eq, desc } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { listBuiltinFactors } from '../definitions/validator.js';
import type {
  CompositeFactorResearchReport,
  CompositeFactorRunConfig,
  DailyFactorMetric,
  FactorDefinition,
  FactorResearchReport,
  FactorRunConfig,
} from '../definitions/schema.js';

export interface FactorCatalogItem {
  definition: FactorDefinition;
  versionId: string;
  version: number;
  checksum: string;
  publishedAt: string;
}

export interface PersistedFactorRun {
  runId: string;
  reportId: string;
}

export interface FactorRunStatusUpdate {
  run: typeof schema.factorRuns.$inferSelect;
  updated: boolean;
  reason?: string;
}

const BUILTIN_VERSION = 1;
const DEFAULT_PREPROCESSING_CONFIG = {
  winsorize: 'none',
  standardize: 'none',
  neutralize: 'none',
};

export async function syncBuiltinFactorCatalog(): Promise<FactorCatalogItem[]> {
  const db = getDb();
  const now = new Date().toISOString();
  const factors = listBuiltinFactors();
  for (const factor of factors) {
    const checksum = checksumFactor(factor);
    await db.insert(schema.factorDefinitions)
      .values({
        id: factor.id,
        name: factor.name,
        description: factor.description,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          name: factor.name,
          description: factor.description,
          status: 'active',
          updatedAt: now,
        },
      });
    await db.insert(schema.factorVersions)
      .values({
        id: factorVersionId(factor.id),
        factorId: factor.id,
        version: BUILTIN_VERSION,
        expression: factor.expression,
        direction: factor.direction,
        dependencies: factor.dependencies,
        warmupDays: factor.warmupDays,
        checksum,
        publishedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          expression: factor.expression,
          direction: factor.direction,
          dependencies: factor.dependencies,
          warmupDays: factor.warmupDays,
          checksum,
        },
      });
  }
  return listFactorCatalog();
}

export async function listFactorCatalog(): Promise<FactorCatalogItem[]> {
  const db = getDb();
  const rows = await db.select({
    id: schema.factorDefinitions.id,
    name: schema.factorDefinitions.name,
    description: schema.factorDefinitions.description,
    status: schema.factorDefinitions.status,
    versionId: schema.factorVersions.id,
    version: schema.factorVersions.version,
    expression: schema.factorVersions.expression,
    direction: schema.factorVersions.direction,
    dependencies: schema.factorVersions.dependencies,
    warmupDays: schema.factorVersions.warmupDays,
    checksum: schema.factorVersions.checksum,
    publishedAt: schema.factorVersions.publishedAt,
  })
    .from(schema.factorDefinitions)
    .innerJoin(
      schema.factorVersions,
      eq(schema.factorDefinitions.id, schema.factorVersions.factorId),
    )
    .where(eq(schema.factorDefinitions.status, 'active'))
    .orderBy(schema.factorDefinitions.id);
  return rows.map((row) => ({
    definition: {
      id: row.id,
      name: row.name,
      description: row.description,
      direction: row.direction as FactorDefinition['direction'],
      dependencies: row.dependencies as FactorDefinition['dependencies'],
      warmupDays: row.warmupDays,
      expression: row.expression as FactorDefinition['expression'],
    },
    versionId: row.versionId,
    version: row.version,
    checksum: row.checksum,
    publishedAt: row.publishedAt,
  }));
}

export async function listRecentFactorRuns(limit = 20) {
  const db = getDb();
  return db.select()
    .from(schema.factorRuns)
    .orderBy(desc(schema.factorRuns.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function getFactorRunById(runId: string) {
  const db = getDb();
  const [run] = await db.select()
    .from(schema.factorRuns)
    .where(eq(schema.factorRuns.id, runId))
    .limit(1);
  return run ?? null;
}

export async function persistCompletedFactorRun(
  report: FactorResearchReport & { artifactPath?: string },
  config: FactorRunConfig,
): Promise<PersistedFactorRun> {
  const db = getDb();
  const runId = randomUUID();
  const reportId = randomUUID();
  const now = new Date().toISOString();
  const versionId = factorVersionId(report.factor.id);
  await db.insert(schema.factorRuns).values({
    id: runId,
    factorVersionId: versionId,
    snapshotId: report.snapshotId,
    universeId: universeIdFromConfig(config),
    status: 'completed',
    dateStart: config.startDate,
    dateEnd: config.endDate,
    preprocessingConfig: DEFAULT_PREPROCESSING_CONFIG,
    labelConfig: { horizonDays: config.horizonDays },
    runConfig: config,
    totalDates: report.summary.tradingDays,
    completedDates: report.summary.tradingDays,
    artifactUri: report.artifactPath ?? '',
    errorMessage: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  });
  await db.insert(schema.factorReports).values({
    id: reportId,
    runId,
    summaryMetrics: report.summary,
    reportUri: report.artifactPath ?? '',
    createdAt: now,
  });
  return { runId, reportId };
}

export async function persistCompletedCompositeFactorRun(
  report: CompositeFactorResearchReport & { artifactPath?: string },
  config: CompositeFactorRunConfig,
): Promise<PersistedFactorRun> {
  const db = getDb();
  const runId = randomUUID();
  const reportId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.factorRuns).values({
    id: runId,
    factorVersionId: compositeVersionId(config.factorIds),
    snapshotId: report.snapshotId,
    universeId: universeIdFromConfig(config),
    status: 'completed',
    dateStart: config.startDate,
    dateEnd: config.endDate,
    preprocessingConfig: DEFAULT_PREPROCESSING_CONFIG,
    labelConfig: { horizonDays: config.horizonDays },
    runConfig: config,
    totalDates: report.summary.tradingDays,
    completedDates: report.summary.tradingDays,
    artifactUri: report.artifactPath ?? '',
    errorMessage: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  });
  await db.insert(schema.factorReports).values({
    id: reportId,
    runId,
    summaryMetrics: report.summary,
    reportUri: report.artifactPath ?? '',
    createdAt: now,
  });
  return { runId, reportId };
}

export async function persistFailedFactorRun(
  config: FactorRunConfig | CompositeFactorRunConfig,
  error: unknown,
  snapshotId = 'unavailable',
): Promise<{ runId: string }> {
  const db = getDb();
  const runId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.factorRuns).values({
    id: runId,
    factorVersionId: factorVersionIdFromRunConfig(config),
    snapshotId,
    universeId: universeIdFromConfig(config),
    status: 'failed',
    dateStart: config.startDate,
    dateEnd: config.endDate,
    preprocessingConfig: DEFAULT_PREPROCESSING_CONFIG,
    labelConfig: { horizonDays: config.horizonDays },
    runConfig: config,
    totalDates: 0,
    completedDates: 0,
    artifactUri: '',
    errorMessage: error instanceof Error ? error.message : String(error),
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  });
  return { runId };
}

export async function cancelFactorRun(runId: string): Promise<FactorRunStatusUpdate | null> {
  const db = getDb();
  const run = await getFactorRunById(runId);
  if (!run) return null;
  if (['completed', 'failed', 'canceled', 'cancelled'].includes(run.status)) {
    return {
      run,
      updated: false,
      reason: `当前状态 ${run.status} 不可取消`,
    };
  }
  const now = new Date().toISOString();
  await db.update(schema.factorRuns)
    .set({
      status: 'canceled',
      errorMessage: '用户取消任务',
      finishedAt: now,
    })
    .where(eq(schema.factorRuns.id, runId));
  const updatedRun = await getFactorRunById(runId);
  return {
    run: updatedRun ?? { ...run, status: 'canceled', errorMessage: '用户取消任务', finishedAt: now },
    updated: true,
  };
}

export async function getFactorRunReport(
  runId: string,
  artifactRoot: string,
): Promise<{
  run: typeof schema.factorRuns.$inferSelect;
  reportRecord: typeof schema.factorReports.$inferSelect;
  report: unknown;
  series: {
    daily: { total: number };
  };
} | null> {
  const detail = await readFactorRunReport(runId, artifactRoot);
  if (!detail) return null;
  const report = detail.report as { daily?: unknown[] };
  const dailyTotal = Array.isArray(report.daily) ? report.daily.length : 0;
  const { daily: _daily, ...summaryReport } = report;
  return {
    run: detail.run,
    reportRecord: detail.reportRecord,
    report: summaryReport,
    series: {
      daily: { total: dailyTotal },
    },
  };
}

export async function getFactorRunDailySeries(
  runId: string,
  artifactRoot: string,
  page: number,
  pageSize: number,
): Promise<{
  items: DailyFactorMetric[];
  total: number;
  page: number;
  pageSize: number;
} | null> {
  const detail = await readFactorRunReport(runId, artifactRoot);
  if (!detail) return null;
  const report = detail.report as { daily?: unknown[] };
  const daily = Array.isArray(report.daily) ? report.daily : [];
  const safePageSize = Math.min(Math.max(pageSize, 1), 500);
  const total = daily.length;
  const maxPage = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(page, 1), maxPage);
  const start = (safePage - 1) * safePageSize;
  return {
    items: daily.slice(start, start + safePageSize).map(toDailyFactorMetric),
    total,
    page: safePage,
    pageSize: safePageSize,
  };
}

async function readFactorRunReport(
  runId: string,
  artifactRoot: string,
): Promise<{
  run: typeof schema.factorRuns.$inferSelect;
  reportRecord: typeof schema.factorReports.$inferSelect;
  report: unknown;
} | null> {
  const db = getDb();
  const [run] = await db.select()
    .from(schema.factorRuns)
    .where(eq(schema.factorRuns.id, runId))
    .limit(1);
  if (!run) return null;
  const [reportRecord] = await db.select()
    .from(schema.factorReports)
    .where(eq(schema.factorReports.runId, runId))
    .limit(1);
  if (!reportRecord?.reportUri) return null;
  const reportPath = resolve(reportRecord.reportUri);
  const root = resolve(artifactRoot);
  const relativePath = relative(root, reportPath);
  if (relativePath.startsWith('..') || relativePath.includes(':')) {
    throw new Error('报告产物路径不在因子研究产物目录内');
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
  return { run, reportRecord, report };
}

function toDailyFactorMetric(row: unknown): DailyFactorMetric {
  const value = row && typeof row === 'object' ? row as Record<string, unknown> : {};
  return {
    tradeDate: String(value.tradeDate ?? ''),
    sampleCount: Number(value.sampleCount ?? 0),
    ic: nullableNumber(value.ic),
    rankIc: nullableNumber(value.rankIc),
  };
}

function checksumFactor(factor: FactorDefinition): string {
  return createHash('sha256').update(JSON.stringify({
    id: factor.id,
    direction: factor.direction,
    dependencies: factor.dependencies,
    warmupDays: factor.warmupDays,
    expression: factor.expression,
  })).digest('hex');
}

function factorVersionId(factorId: string): string {
  return `${factorId}:v${BUILTIN_VERSION}`;
}

function compositeVersionId(factorIds: string[]): string {
  const checksum = createHash('sha1').update(factorIds.join('|')).digest('hex').slice(0, 16);
  return `composite:${checksum}`;
}

function factorVersionIdFromRunConfig(config: FactorRunConfig | CompositeFactorRunConfig): string {
  return 'factorIds' in config
    ? compositeVersionId(config.factorIds)
    : factorVersionId(config.factorId);
}

function universeIdFromConfig(config: FactorRunConfig | CompositeFactorRunConfig): string {
  if (config.symbols?.length) return `symbols:${config.symbols.join(',')}`;
  if (config.markets?.length) return `markets:${config.markets.join(',')}`;
  return 'builtin-all-a';
}

function nullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
