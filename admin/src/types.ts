export type HealthLevel = 'healthy' | 'warning' | 'critical' | 'disabled';

export interface DiagnosticCheck {
  id: string;
  title: string;
  level: HealthLevel;
  summary: string;
  resolution?: string;
}

export interface AdminOverview {
  generatedAt: string;
  durationMs: number;
  overall: HealthLevel;
  counts: Record<HealthLevel, number>;
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
  duckdb: {
    active: number;
    queued: number;
    limit: number;
    queueLimit: number;
  };
  storage: {
    disk: {
      totalBytes: number;
      freeBytes: number;
      usedPercent: number;
    } | null;
    roots: Array<{
      id: string;
      label: string;
      path: string;
      available: boolean;
      manifestAvailable?: boolean | null;
    }>;
  };
  dataGovernance: {
    lineage: {
      mysqlAuthoritativeDate: string | null;
      snapshotId: string | null;
      snapshotCreatedAt: string | null;
      snapshotSourceVersion: string | null;
      snapshotMaxDate: string | null;
      minutePreparedAt: string | null;
      minuteMaxDate: string | null;
    };
    coverage: {
      status: 'pass' | 'warn' | 'fail';
      checkedAt: string;
      authoritativeDate: string | null;
      rows: Array<{
        key: string;
        label: string;
        status: 'pass' | 'warn' | 'fail';
        rows: number;
        covered: number;
        total: number;
        coverage: number;
        minDate: string | null;
        maxDate: string | null;
        message: string;
      }>;
    } | null;
    materialized: {
      total: number;
      current: number;
      stale: number;
      invalid: number;
      staleBytes: number;
      staleSnapshots: string[];
    } | null;
  };
  tasks: {
    syncJobs: Record<string, number>;
    miningTasks: Record<string, number>;
    recentFailures?: {
      syncJobs: number;
      miningTasks: number;
    };
  };
  configuration: {
    configured: number;
    total: number;
  };
  checks: DiagnosticCheck[];
}

export interface AdminConfigItem {
  key: string;
  label: string;
  category: 'access' | 'database' | 'ai' | 'market' | 'runtime';
  description: string;
  secret: boolean;
  editable: boolean;
  restartRequired: boolean;
  restartScope: 'db' | 'ai' | 'runtime' | 'market' | 'access';
  configured: boolean;
  maskedValue: string | null;
}

/** 轻量健康快照（/api/admin/health），是 AdminOverview 的子集 */
export interface AdminHealth {
  generatedAt: string;
  durationMs: number;
  overall: HealthLevel;
  counts: Record<HealthLevel, number>;
  service: AdminOverview['service'];
  database: AdminOverview['database'];
  duckdb: AdminOverview['duckdb'];
}

export interface MetricSample {
  timestamp: string;
  rssBytes: number;
  heapUsedBytes: number;
  databaseLatencyMs: number | null;
  duckdbActive: number;
  duckdbQueued: number;
  diskUsedPercent: number | null;
  taskFailures: number;
}

export interface MetricsHistoryResponse {
  samples: MetricSample[];
}
