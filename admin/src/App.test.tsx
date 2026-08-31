import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { AdminShell } from './App';
import type { AdminHealth, AdminOverview, AgentOperations } from './types';

const api = vi.hoisted(() => ({
  getAdminConfig: vi.fn(),
  getAdminHealth: vi.fn(),
  getAdminOverview: vi.fn(),
  getAdminStatus: vi.fn(),
  getAgentOperations: vi.fn(),
  getBackendRestartStatus: vi.fn(),
  getDataUpdateProgress: vi.fn(),
  getDatabaseBackupExport: vi.fn(),
  getMetricsHistory: vi.fn(),
  getPublicAccessStatus: vi.fn(),
  restartBackend: vi.fn(),
  startDatabaseBackupExport: vi.fn(),
  downloadDatabaseBackupExport: vi.fn(),
  updateAdminConfig: vi.fn(),
  updatePublicAccess: vi.fn(),
  verifyAdminToken: vi.fn(),
  waitForBackendRecovery: vi.fn(),
}));

vi.mock('./api', () => ({
  ...api,
  AdminApiError: class MockAdminApiError extends Error {
    status = 0;
  },
}));

const overview: AdminOverview = {
  generatedAt: '2026-08-31T09:00:00.000Z',
  durationMs: 22,
  overall: 'healthy',
  counts: { healthy: 3, warning: 0, critical: 0, disabled: 0 },
  service: {
    status: 'healthy',
    uptimeSeconds: 3600,
    nodeVersion: 'v22.0.0',
    platform: 'win32',
    pid: 1234,
    memory: { rssBytes: 1024, heapUsedBytes: 512, heapTotalBytes: 1024, systemTotalBytes: 4096 },
    cpuMicroseconds: 100,
  },
  database: {
    status: 'healthy',
    latencyMs: 4,
    version: '8.0',
    threadsConnected: 1,
    threadsRunning: 0,
    maxConnections: 10,
  },
  duckdb: { active: 1, queued: 0, limit: 4, queueLimit: 20 },
  storage: { disk: null, roots: [] },
  dataGovernance: {
    lineage: {
      mysqlAuthoritativeDate: null,
      snapshotId: null,
      snapshotCreatedAt: null,
      snapshotSourceVersion: null,
      snapshotMaxDate: null,
      minutePreparedAt: null,
      minuteMaxDate: null,
    },
    coverage: null,
    collectorHealth: null,
    materialized: null,
  },
  tasks: { syncJobs: {}, miningTasks: {}, recentFailures: { syncJobs: 0, miningTasks: 0 } },
  configuration: { configured: 0, total: 0 },
  checks: [],
};

const health: AdminHealth = {
  generatedAt: overview.generatedAt,
  durationMs: overview.durationMs,
  overall: overview.overall,
  counts: overview.counts,
  service: overview.service,
  database: overview.database,
  duckdb: overview.duckdb,
};

const agentOperations: AgentOperations = {
  enabled: true,
  defaultProvider: 'codex',
  runtime: { active: 1, capacity: 4 },
  providers: [{ id: 'codex', enabled: true, available: true, reason: null, capabilities: { completion: true } }],
  codex: {
    enabled: true,
    version: '1.0.0',
    model: 'gpt-5',
    modelProvider: 'openai',
    baseUrlConfigured: true,
    apiKeyConfigured: true,
    isolatedHome: true,
    approvalsEnabled: false,
    toolsEnabled: true,
    sandboxMode: 'workspace-write',
    windowsSandbox: 'unelevated',
    networkEnabled: true,
    marketDataCliConfigured: true,
    externalDataSkillEnabled: true,
    isolatedPythonConfigured: true,
  },
  persistence: { statuses: {}, events: 2, eventBytes: 128, conversations: 1 },
  pendingApprovals: 0,
  recentFailures: [],
  observedAt: overview.generatedAt,
};

function setHealthyApiDefaults() {
  api.getAdminOverview.mockResolvedValue(overview);
  api.getAdminHealth.mockResolvedValue(health);
  api.getAdminStatus.mockResolvedValue({ enabled: true });
  api.getAgentOperations.mockResolvedValue(agentOperations);
  api.getAdminConfig.mockResolvedValue([]);
  api.getBackendRestartStatus.mockResolvedValue({ available: false, reason: '测试中已禁用危险操作' });
  api.getDataUpdateProgress.mockResolvedValue({ generatedAt: overview.generatedAt, items: [] });
  api.getDatabaseBackupExport.mockResolvedValue({
    id: 'backup-1', status: 'idle', createdAt: null, startedAt: null, updatedAt: overview.generatedAt,
    finishedAt: null, fileName: null, bytes: null, sha256: null, error: null,
  });
  api.getMetricsHistory.mockResolvedValue({ samples: [] });
  api.getPublicAccessStatus.mockResolvedValue({ available: false, enabled: false, running: false, domain: '', message: null, tasks: [] });
  api.verifyAdminToken.mockResolvedValue(undefined);
  api.restartBackend.mockResolvedValue({ accepted: true, requestedAt: overview.generatedAt });
  api.startDatabaseBackupExport.mockResolvedValue({});
  api.downloadDatabaseBackupExport.mockResolvedValue(undefined);
  api.updateAdminConfig.mockResolvedValue({ updatedKeys: [], restartRequired: false, message: '' });
  api.updatePublicAccess.mockResolvedValue({});
  api.waitForBackendRecovery.mockResolvedValue(health);
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

beforeEach(() => {
  setHealthyApiDefaults();
});

describe('admin operations states', () => {
  it('renders the healthy Agent workspace with five metric cards', async () => {
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('所有核心服务运行正常')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Agent 运维/ }));
    expect(await screen.findByText('项目 Agent 服务可用')).toBeInTheDocument();
    const agentGrid = screen.getByLabelText('Agent 运行指标');

    expect(agentGrid.className).toContain('metric-grid--agent');
    expect(agentGrid.querySelectorAll('.metric-card')).toHaveLength(5);
  });

  it('shows a retryable empty failure state when the first read fails', async () => {
    api.getAdminOverview.mockRejectedValueOnce(new Error('模拟连接失败'));
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('模拟连接失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新连接/ })).toBeInTheDocument();
  });

  it('keeps the Agent empty state explicit when no provider is returned', async () => {
    api.getAgentOperations.mockResolvedValueOnce({ ...agentOperations, providers: [], recentFailures: [] });
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('所有核心服务运行正常')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Agent 运维/ }));

    expect(await screen.findByText('Provider 未启动')).toBeInTheDocument();
    expect(screen.getByText('没有近期失败')).toBeInTheDocument();
  });

  it('does not enter the dashboard before the token is submitted and verified', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: '量化平台运维管理台' })).toBeInTheDocument());
    expect(api.verifyAdminToken).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('管理台访问令牌'), { target: { value: 'user-supplied-token' } });
    fireEvent.click(screen.getByRole('button', { name: /进入管理台/ }));

    await waitFor(() => expect(screen.getByText('所有核心服务运行正常')).toBeInTheDocument());
    expect(api.verifyAdminToken).toHaveBeenCalledWith('user-supplied-token');
  });
});
