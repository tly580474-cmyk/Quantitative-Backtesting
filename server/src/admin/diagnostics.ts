import { access, readFile, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { platform, release, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { EnvConfig } from '../config.js';
import {
  buildDataCoverageMatrix,
  readCoverageMatrixCache,
  writeCoverageMatrixCache,
} from '../research/dataCoverageMatrix.js';
import { getDuckDBRuntimeStats } from '../research/duckdbRuntime.js';
import { evaluateMarketCollectorHealth, readMarketCollectorState } from '../research/dataHealthGate.js';
import { inspectMaterializedArtifacts } from '../research/materializedArtifactHealth.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';
import { listAdminConfig } from './envConfig.js';
import { metricsHistory } from './metricsHistory.js';

export type HealthLevel = 'healthy' | 'warning' | 'critical' | 'disabled';

interface DiagnosticCheck {
  id: string;
  title: string;
  level: HealthLevel;
  summary: string;
  resolution?: string;
}

export async function collectAdminOverview(input: {
  pool: Pool;
  dbOnline: boolean;
  config: EnvConfig;
  envFilePath: string | URL;
}) {
  const started = performance.now();
  const [database, storage, tasks, governance] = await Promise.all([
    inspectDatabase(input.pool, input.dbOnline),
    inspectStorage(input.config),
    inspectTasks(input.pool, input.dbOnline),
    inspectDataGovernance(input.pool, input.dbOnline, input.config),
  ]);
  const configuration = inspectConfiguration(input.config, input.envFilePath);
  const configItems = listAdminConfig({ ...input.config, ...process.env });
  const checks = [
    ...configuration.checks,
    ...database.checks,
    ...storage.checks,
    ...tasks.checks,
    ...governance.checks,
  ];
  const criticalCount = checks.filter((item) => item.level === 'critical').length;
  const warningCount = checks.filter((item) => item.level === 'warning').length;
  const overall: HealthLevel = criticalCount > 0
    ? 'critical'
    : warningCount > 0 ? 'warning' : 'healthy';
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const duckdbStats = getDuckDBRuntimeStats();
  const taskFailures = (tasks.summary.recentFailures?.syncJobs ?? 0)
    + (tasks.summary.recentFailures?.miningTasks ?? 0);

  metricsHistory.push({
    timestamp: new Date().toISOString(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    databaseLatencyMs: database.summary.latencyMs,
    duckdbActive: duckdbStats.active,
    duckdbQueued: duckdbStats.queued,
    diskUsedPercent: storage.summary.disk?.usedPercent ?? null,
    taskFailures,
  });

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    overall,
    counts: {
      critical: criticalCount,
      warning: warningCount,
      healthy: checks.filter((item) => item.level === 'healthy').length,
      disabled: checks.filter((item) => item.level === 'disabled').length,
    },
    service: {
      status: 'healthy' as const,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: `${platform()} ${release()}`,
      pid: process.pid,
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        systemTotalBytes: totalmem(),
      },
      cpuMicroseconds: cpu.user + cpu.system,
    },
    database: database.summary,
    duckdb: duckdbStats,
    storage: storage.summary,
    dataGovernance: governance.summary,
    tasks: tasks.summary,
    configuration: {
      configured: configItems.filter((item) => item.configured).length,
      total: configItems.length,
    },
    checks,
  };
}

export type AdminOverview = Awaited<ReturnType<typeof collectAdminOverview>>;

export interface AdminHealthSnapshot {
  generatedAt: string;
  durationMs: number;
  overall: HealthLevel;
  counts: { critical: number; warning: number; healthy: number; disabled: number };
  service: {
    status: HealthLevel;
    uptimeSeconds: number;
    nodeVersion: string;
    platform: string;
    pid: number;
    memory: {
      rssBytes: number;
      heapUsedBytes: number;
      heapTotalBytes: number;
      systemTotalBytes: number;
    };
    cpuMicroseconds: number;
  };
  database: {
    status: HealthLevel;
    latencyMs: number | null;
    version: string | null;
    threadsConnected: number | null;
    threadsRunning: number | null;
    maxConnections: number | null;
  };
  duckdb: ReturnType<typeof getDuckDBRuntimeStats>;
}

/**
 * 轻量健康快照，供高频轮询使用（见 §2）。
 * 只跑一次 SELECT VERSION() + statfs + process.memoryUsage + DuckDB stats。
 * 不跑 storage 全扫、tasks 近 24h 失败查询、materialized 扫描、config 枚举。
 */
export async function collectAdminHealth(input: {
  pool: Pool;
  dbOnline: boolean;
  config: EnvConfig;
}): Promise<AdminHealthSnapshot> {
  const started = performance.now();
  const checks: DiagnosticCheck[] = [];

  let database: AdminHealthSnapshot['database'];
  if (!input.dbOnline) {
    checks.push({
      id: 'database-connection',
      title: 'MySQL 连接',
      level: 'critical',
      summary: '服务启动时未能连接 MySQL。',
    });
    database = {
      status: 'critical',
      latencyMs: null,
      version: null,
      threadsConnected: null,
      threadsRunning: null,
      maxConnections: null,
    };
  } else {
    const pingStart = performance.now();
    try {
      const [rows] = await input.pool.query<RowDataPacket[]>('SELECT VERSION() AS version');
      const latencyMs = Math.round(performance.now() - pingStart);
      checks.push({
        id: 'database-connection',
        title: 'MySQL 连接',
        level: latencyMs > 1000 ? 'warning' : 'healthy',
        summary: `连接正常，诊断查询耗时 ${latencyMs}ms。`,
      });
      database = {
        status: latencyMs > 1000 ? 'warning' : 'healthy',
        latencyMs,
        version: String(rows[0]?.version ?? ''),
        threadsConnected: null,
        threadsRunning: null,
        maxConnections: null,
      };
    } catch (error) {
      checks.push({
        id: 'database-connection',
        title: 'MySQL 连接',
        level: 'critical',
        summary: error instanceof Error ? error.message : '数据库连接失败。',
      });
      database = {
        status: 'critical',
        latencyMs: null,
        version: null,
        threadsConnected: null,
        threadsRunning: null,
        maxConnections: null,
      };
    }
  }

  // 快速磁盘检查（单次 statfs，不做全目录扫描）
  let diskUsedPercent: number | null = null;
  try {
    const info = await statfs(dirname(resolve(input.config.RESEARCH_SNAPSHOT_ROOT)));
    const totalBytes = info.blocks * info.bsize;
    const freeBytes = info.bavail * info.bsize;
    diskUsedPercent = totalBytes > 0 ? (totalBytes - freeBytes) / totalBytes : 0;
    if (diskUsedPercent >= 0.9) {
      checks.push({
        id: 'storage-disk',
        title: '磁盘空间',
        level: 'critical',
        summary: `研究数据所在磁盘已使用 ${Math.round(diskUsedPercent * 100)}%。`,
      });
    } else if (diskUsedPercent >= 0.8) {
      checks.push({
        id: 'storage-disk',
        title: '磁盘空间',
        level: 'warning',
        summary: `研究数据所在磁盘已使用 ${Math.round(diskUsedPercent * 100)}%。`,
      });
    }
  } catch {
    // 磁盘检查失败不影响健康快照
  }

  const duckdbStats = getDuckDBRuntimeStats();
  if (duckdbStats.queued > 0) {
    checks.push({
      id: 'duckdb-queue',
      title: 'DuckDB 查询队列',
      level: 'warning',
      summary: `${duckdbStats.queued} 个查询正在排队等待。`,
    });
  }

  const criticalCount = checks.filter((item) => item.level === 'critical').length;
  const warningCount = checks.filter((item) => item.level === 'warning').length;
  const overall: HealthLevel = criticalCount > 0
    ? 'critical'
    : warningCount > 0 ? 'warning' : 'healthy';

  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();

  // 推送指标采样（高频轮询来源）
  metricsHistory.push({
    timestamp: new Date().toISOString(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    databaseLatencyMs: database.latencyMs,
    duckdbActive: duckdbStats.active,
    duckdbQueued: duckdbStats.queued,
    diskUsedPercent,
    taskFailures: 0,
  });

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    overall,
    counts: {
      critical: criticalCount,
      warning: warningCount,
      healthy: checks.filter((item) => item.level === 'healthy').length,
      disabled: checks.filter((item) => item.level === 'disabled').length,
    },
    service: {
      status: 'healthy' as const,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: `${platform()} ${release()}`,
      pid: process.pid,
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        systemTotalBytes: totalmem(),
      },
      cpuMicroseconds: cpu.user + cpu.system,
    },
    database,
    duckdb: duckdbStats,
  };
}

async function inspectDataGovernance(pool: Pool, dbOnline: boolean, config: EnvConfig) {
  const checks: DiagnosticCheck[] = [];
  const snapshot = await readCurrentSnapshot(resolve(config.RESEARCH_SNAPSHOT_ROOT)).catch(() => null);
  let minute: Record<string, unknown> | null = null;
  try {
    minute = JSON.parse(
      await readFile(resolve(config.MINUTE_DATA_ROOT, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    minute = null;
  }
  const minuteYears = Array.isArray(minute?.years)
    ? minute.years as Record<string, unknown>[]
    : [];
  const minuteLastDates = minuteYears
    .map((item) => typeof item.lastDate === 'string' ? item.lastDate : null)
    .filter((item): item is string => item !== null)
    .sort();
  const [coverage, materialized, collectorState] = await Promise.all([
    dbOnline
      ? loadAdminCoverage(pool, config).catch((error) => {
          checks.push({
            id: 'data-coverage',
            title: '数据覆盖矩阵',
            level: 'warning',
            summary: error instanceof Error ? error.message : '数据覆盖矩阵生成失败。',
            resolution: '运行 npm run data:coverage 并检查数据库迁移、权限和分钟 manifest。',
          });
          return null;
        })
      : Promise.resolve(null),
    inspectMaterializedArtifacts(
      config.FACTOR_RESEARCH_ROOT,
      snapshot?.manifest.snapshotId ?? null,
    ).catch(() => null),
    dbOnline ? readMarketCollectorState(pool).catch(() => null) : Promise.resolve(null),
  ]);
  const collectorHealth = collectorState ? evaluateMarketCollectorHealth(collectorState) : [];
  for (const check of collectorHealth) {
    checks.push({
      id: check.key,
      title: check.key === 'dragon_tiger_freshness'
        ? '龙虎榜采集新鲜度'
        : check.key === 'market_news_collector_heartbeat' ? '新闻采集心跳' : '新闻来源成功率',
      level: check.status === 'pass' ? 'healthy' : check.status === 'warn' ? 'warning' : 'critical',
      summary: check.message,
      resolution: check.status === 'pass' ? undefined : '检查采集任务运行记录、外部数据源连通性与采集开关配置。',
    });
  }
  if (coverage) {
    const failing = coverage.rows.filter((row) => row.status !== 'pass');
    checks.push({
      id: 'data-coverage',
      title: '数据覆盖矩阵',
      level: coverage.status === 'fail' ? 'critical' : coverage.status === 'warn' ? 'warning' : 'healthy',
      summary: failing.length === 0
        ? `${coverage.rows.length} 个数据域全部通过覆盖检查。`
        : `${failing.length}/${coverage.rows.length} 个数据域未通过覆盖检查。`,
      resolution: failing.length > 0 ? '查看管理台数据血缘区域，或运行 npm run data:coverage。' : undefined,
    });
  }
  if (materialized && (materialized.stale > 0 || materialized.invalid > 0)) {
    checks.push({
      id: 'materialized-artifacts-stale',
      title: 'DuckDB 持久研究结果',
      level: materialized.invalid > 0 ? 'warning' : 'warning',
      summary: `${materialized.stale} 个结果引用旧快照，${materialized.invalid} 个结果 manifest 无效。`,
      resolution: '旧结果不会被当前快照复用；确认无研究引用后归档或清理对应 snapshot 目录。',
    });
  } else {
    checks.push({
      id: 'materialized-artifacts-stale',
      title: 'DuckDB 持久研究结果',
      level: 'healthy',
      summary: '未发现过期或无效的持久因子物化结果。',
    });
  }
  return {
    checks,
    summary: {
      lineage: {
        mysqlAuthoritativeDate: coverage?.authoritativeDate ?? null,
        snapshotId: snapshot?.manifest.snapshotId ?? null,
        snapshotCreatedAt: snapshot?.manifest.createdAt ?? null,
        snapshotSourceVersion: snapshot?.manifest.sourceVersion ?? null,
        snapshotMaxDate: snapshot?.manifest.maxDate ?? null,
        minutePreparedAt: typeof minute?.preparedAt === 'string' ? minute.preparedAt : null,
        minuteMaxDate: typeof minute?.lastDate === 'string'
          ? minute.lastDate
          : minuteLastDates[minuteLastDates.length - 1] ?? null,
      },
      coverage,
      collectorHealth: collectorState ? {
        status: collectorHealth.some((check) => check.status === 'fail')
          ? 'fail' as const
          : collectorHealth.some((check) => check.status === 'warn') ? 'warn' as const : 'pass' as const,
        checks: collectorHealth,
        state: collectorState,
      } : null,
      materialized,
    },
  };
}

async function loadAdminCoverage(pool: Pool, config: EnvConfig) {
  const cachePath = resolve('.cache/data-coverage.json');
  const cached = await readCoverageMatrixCache(cachePath, 15 * 60_000);
  if (cached?.rows.some((row) => row.key === 'dragon_tiger')) return cached;
  const matrix = await buildDataCoverageMatrix(pool, config.MINUTE_DATA_ROOT);
  await writeCoverageMatrixCache(cachePath, matrix);
  return matrix;
}

async function inspectDatabase(pool: Pool, dbOnline: boolean) {
  const checks: DiagnosticCheck[] = [];
  if (!dbOnline) {
    checks.push({
      id: 'database-connection',
      title: 'MySQL 连接',
      level: 'critical',
      summary: '服务启动时未能连接 MySQL。',
      resolution: '检查 MySQL 服务、DB_HOST、DB_PORT、DB_USER、DB_PASSWORD 和 DB_NAME，修改后重启后端。',
    });
    return {
      checks,
      summary: {
        status: 'critical' as const,
        latencyMs: null,
        version: null,
        threadsConnected: null,
        threadsRunning: null,
        maxConnections: null,
      },
    };
  }

  const started = performance.now();
  try {
    const [versionRows] = await pool.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const [statusRows] = await pool.query<RowDataPacket[]>(
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running')",
    );
    const [variableRows] = await pool.query<RowDataPacket[]>(
      "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections')",
    );
    const statuses: Record<string, number> = Object.fromEntries(
      statusRows.map((row) => [String(row.Variable_name), Number(row.Value)]),
    );
    const variables: Record<string, number> = Object.fromEntries(
      variableRows.map((row) => [String(row.Variable_name), Number(row.Value)]),
    );
    const latencyMs = Math.round(performance.now() - started);
    const usage = variables.max_connections
      ? (statuses.Threads_connected ?? 0) / variables.max_connections
      : 0;
    checks.push({
      id: 'database-connection',
      title: 'MySQL 连接',
      level: latencyMs > 1000 ? 'warning' : 'healthy',
      summary: latencyMs > 1000 ? `连接正常，但诊断查询耗时 ${latencyMs}ms。` : `连接正常，诊断查询耗时 ${latencyMs}ms。`,
      resolution: latencyMs > 1000 ? '检查磁盘、慢查询、锁等待和主机负载。' : undefined,
    });
    if (usage >= 0.8) {
      checks.push({
        id: 'database-connections',
        title: 'MySQL 连接使用率',
        level: 'warning',
        summary: `当前连接占最大连接数的 ${Math.round(usage * 100)}%。`,
        resolution: '检查长连接和连接泄漏，确认连接池上限与 MySQL max_connections 是否匹配。',
      });
    }
    return {
      checks,
      summary: {
        status: latencyMs > 1000 ? 'warning' as const : 'healthy' as const,
        latencyMs,
        version: String(versionRows[0]?.version ?? ''),
        threadsConnected: statuses.Threads_connected ?? null,
        threadsRunning: statuses.Threads_running ?? null,
        maxConnections: variables.max_connections ?? null,
      },
    };
  } catch (error) {
    checks.push({
      id: 'database-query',
      title: 'MySQL 诊断查询',
      level: 'critical',
      summary: error instanceof Error ? error.message : '数据库诊断查询失败。',
      resolution: '检查数据库权限、连接稳定性和迁移状态。',
    });
    return {
      checks,
      summary: {
        status: 'critical' as const,
        latencyMs: null,
        version: null,
        threadsConnected: null,
        threadsRunning: null,
        maxConnections: null,
      },
    };
  }
}

async function inspectStorage(config: EnvConfig) {
  const snapshotRoot = resolve(config.RESEARCH_SNAPSHOT_ROOT);
  const minuteRoot = resolve(config.MINUTE_DATA_ROOT);
  const factorRoot = resolve(config.FACTOR_RESEARCH_ROOT);
  const roots = [
    { id: 'snapshot', label: '研究快照', path: snapshotRoot, manifest: resolve(snapshotRoot, 'current.json') },
    { id: 'minute', label: '分钟数据湖', path: minuteRoot, manifest: resolve(minuteRoot, 'manifest.json') },
    { id: 'factor', label: '因子报告', path: factorRoot },
    { id: 'miner', label: '因子挖掘运行时', path: resolve(config.FACTOR_MINER_ROOT) },
  ];
  const items = [];
  const checks: DiagnosticCheck[] = [];
  for (const root of roots) {
    let available = false;
    let manifestAvailable: boolean | null = null;
    try {
      await access(root.path);
      available = true;
      if (root.manifest) {
        try {
          await readFile(root.manifest, 'utf8');
          manifestAvailable = true;
        } catch {
          manifestAvailable = false;
        }
      }
    } catch {
      available = false;
    }
    items.push({ ...root, available, manifestAvailable });
    if (!available || manifestAvailable === false) {
      checks.push({
        id: `storage-${root.id}`,
        title: root.label,
        level: root.id === 'snapshot' ? 'critical' : 'warning',
        summary: !available ? `目录不可访问：${root.path}` : `目录存在，但发布清单缺失。`,
        resolution: root.id === 'snapshot'
          ? '运行 snapshot:build、snapshot:verify 和 snapshot:publish。'
          : '检查数据准备或更新任务及目录配置。',
      });
    }
  }

  let disk = null;
  try {
    const info = await statfs(dirname(snapshotRoot));
    const totalBytes = info.blocks * info.bsize;
    const freeBytes = info.bavail * info.bsize;
    disk = { totalBytes, freeBytes, usedPercent: totalBytes > 0 ? (totalBytes - freeBytes) / totalBytes : 0 };
    if (disk.usedPercent >= 0.9) {
      checks.push({
        id: 'storage-disk',
        title: '磁盘空间',
        level: 'critical',
        summary: `研究数据所在磁盘已使用 ${Math.round(disk.usedPercent * 100)}%。`,
        resolution: '清理过期快照、DuckDB 临时目录和历史报告，或扩容磁盘。',
      });
    } else if (disk.usedPercent >= 0.8) {
      checks.push({
        id: 'storage-disk',
        title: '磁盘空间',
        level: 'warning',
        summary: `研究数据所在磁盘已使用 ${Math.round(disk.usedPercent * 100)}%。`,
        resolution: '评估快照、分钟数据和报告增长速度，提前安排清理或扩容。',
      });
    }
  } catch {
    checks.push({
      id: 'storage-disk',
      title: '磁盘空间',
      level: 'warning',
      summary: '无法读取研究数据所在磁盘的容量信息。',
    });
  }

  return { checks, summary: { disk, roots: items } };
}

async function inspectTasks(pool: Pool, dbOnline: boolean) {
  const checks: DiagnosticCheck[] = [];
  if (!dbOnline) return { checks, summary: { syncJobs: {}, miningTasks: {}, recentFailures: { syncJobs: 0, miningTasks: 0 } } };
  const queryCounts = async (table: string, where = '') => {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT status, COUNT(*) AS count FROM ${table} ${where} GROUP BY status`,
      );
      return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
    } catch {
      return {};
    }
  };

  // §3 近 24h 失败任务查询重写：
  // 去掉 STR_TO_DATE(LEFT(...)) 包裹，改用字符串直接比较（created_at 是 varchar(24) 存 ISO 格式，
  // 与 cutoff 字符串比较可走 idx_sj_status_created 索引）。
  // runKey 恢复判定下推到应用层，避免相关子查询逐行 JSON_EXTRACT。
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19);

  const [syncJobs, miningTasks, recentMiningFailures, failedRows, completedRows] = await Promise.all([
    queryCounts('sync_jobs'),
    queryCounts('factor_mining_tasks', 'WHERE deleted_at IS NULL AND archived_at IS NULL'),
    // factor_mining_tasks 已有 idx_fmt_status_created(status, created_at)，直接字符串比较走索引
    (async () => {
      try {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS count FROM factor_mining_tasks
           WHERE status='failed' AND deleted_at IS NULL AND archived_at IS NULL
             AND created_at >= ?`,
          [cutoff],
        );
        return Number(rows[0]?.count ?? 0);
      } catch {
        return 0;
      }
    })(),
    // 近 24h 失败的 sync_jobs（走索引 idx_sj_status_created）
    (async () => {
      try {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT request_snapshot, created_at FROM sync_jobs
           WHERE status='failed' AND created_at >= ?`,
          [cutoff],
        );
        return rows as Array<{ request_snapshot: unknown; created_at: string }>;
      } catch {
        return [];
      }
    })(),
    // 近 24h 完成的 sync_jobs（用于恢复判定，走索引）
    (async () => {
      try {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT request_snapshot, created_at FROM sync_jobs
           WHERE status='completed' AND created_at >= ?`,
          [cutoff],
        );
        return rows as Array<{ request_snapshot: unknown; created_at: string }>;
      } catch {
        return [];
      }
    })(),
  ]);

  // 应用层恢复判定：对每个失败任务，检查是否存在同 runKey 且更晚的 completed 任务
  const completedRunKeyLatest = new Map<string, string>();
  for (const row of completedRows) {
    const runKey = extractRunKey(row.request_snapshot);
    if (!runKey) continue;
    const existing = completedRunKeyLatest.get(runKey);
    if (!existing || row.created_at > existing) {
      completedRunKeyLatest.set(runKey, row.created_at);
    }
  }
  let recentSyncFailures = 0;
  for (const failedRow of failedRows) {
    const runKey = extractRunKey(failedRow.request_snapshot);
    if (!runKey) {
      // 没有 runKey 的失败任务无法被恢复，计入未恢复
      recentSyncFailures += 1;
      continue;
    }
    const latestCompleted = completedRunKeyLatest.get(runKey);
    if (!latestCompleted || latestCompleted <= failedRow.created_at) {
      recentSyncFailures += 1;
    }
  }

  const failed = recentSyncFailures + recentMiningFailures;
  if (failed > 0) {
    checks.push({
      id: 'tasks-failed',
      title: '失败任务',
      level: 'warning',
      summary: `最近 24 小时有 ${failed} 个失败任务。`,
      resolution: '查看同步任务或因子挖掘任务的错误信息，确认是否需要重试或归档。',
    });
  }
  return {
    checks,
    summary: {
      syncJobs,
      miningTasks,
      recentFailures: {
        syncJobs: recentSyncFailures,
        miningTasks: recentMiningFailures,
      },
    },
  };
}

/** 从 sync_jobs.request_snapshot 中安全提取 runKey。 */
function extractRunKey(snapshot: unknown): string | null {
  if (snapshot == null || typeof snapshot !== 'object') return null;
  const value = (snapshot as Record<string, unknown>).runKey;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function inspectConfiguration(config: EnvConfig, envFilePath: string | URL) {
  const checks: DiagnosticCheck[] = [];
  if (!config.ADMIN_API_TOKEN.trim()) {
    checks.push({
      id: 'config-admin-token',
      title: '管理台访问令牌',
      level: 'critical',
      summary: 'ADMIN_API_TOKEN 未配置，管理 API 已禁用。',
      resolution: `在 ${resolve(envFilePath instanceof URL ? fileURLToPath(envFilePath) : envFilePath)} 中设置长随机令牌并重启服务。`,
    });
  }
  if (config.AI_STRATEGY_ENABLED === 'true' && !config.OPENAI_API_KEY.trim()) {
    checks.push({
      id: 'config-ai-key',
      title: '大模型密钥',
      level: 'warning',
      summary: 'AI 功能已启用，但 OPENAI_API_KEY 为空，当前会降级为 Mock Provider。',
      resolution: '配置 API Key，确认 Base URL 和模型名称后重启服务。',
    });
  }
  return { checks };
}
