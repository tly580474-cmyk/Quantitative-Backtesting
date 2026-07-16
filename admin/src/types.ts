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
  tasks: {
    syncJobs: Record<string, number>;
    miningTasks: Record<string, number>;
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
  configured: boolean;
  maskedValue: string | null;
}
