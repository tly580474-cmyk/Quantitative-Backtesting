import { access, readFile, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { platform, release, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { EnvConfig } from '../config.js';
import { getDuckDBRuntimeStats } from '../research/duckdbRuntime.js';
import { listAdminConfig } from './envConfig.js';

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
  const [database, storage, tasks] = await Promise.all([
    inspectDatabase(input.pool, input.dbOnline),
    inspectStorage(input.config),
    inspectTasks(input.pool, input.dbOnline),
  ]);
  const configuration = inspectConfiguration(input.config, input.envFilePath);
  const configItems = listAdminConfig({ ...input.config, ...process.env });
  const checks = [
    ...configuration.checks,
    ...database.checks,
    ...storage.checks,
    ...tasks.checks,
  ];
  const criticalCount = checks.filter((item) => item.level === 'critical').length;
  const warningCount = checks.filter((item) => item.level === 'warning').length;
  const overall: HealthLevel = criticalCount > 0
    ? 'critical'
    : warningCount > 0 ? 'warning' : 'healthy';
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();

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
    duckdb: getDuckDBRuntimeStats(),
    storage: storage.summary,
    tasks: tasks.summary,
    configuration: {
      configured: configItems.filter((item) => item.configured).length,
      total: configItems.length,
    },
    checks,
  };
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
  if (!dbOnline) return { checks, summary: { syncJobs: {}, miningTasks: {} } };
  const queryCounts = async (table: string) => {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`,
      );
      return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
    } catch {
      return {};
    }
  };
  const [syncJobs, miningTasks] = await Promise.all([
    queryCounts('sync_jobs'),
    queryCounts('factor_mining_tasks'),
  ]);
  const failed = (syncJobs.failed ?? 0) + (miningTasks.failed ?? 0);
  if (failed > 0) {
    checks.push({
      id: 'tasks-failed',
      title: '失败任务',
      level: 'warning',
      summary: `当前历史记录中有 ${failed} 个失败任务。`,
      resolution: '查看同步任务或因子挖掘任务的错误信息，确认是否需要重试或归档。',
    });
  }
  return { checks, summary: { syncJobs, miningTasks } };
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
