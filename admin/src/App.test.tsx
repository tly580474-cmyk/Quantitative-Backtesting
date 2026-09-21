import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
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
  claude: { enabled: true, version: '2.0.0', workingDirectoryConfigured: true, gitBashConfigured: false },
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
  it('uses the selected Pi provider for health even when Codex is unavailable', async () => {
    api.getAgentOperations.mockResolvedValue({ ...agentOperations, defaultProvider: 'pi',
      providers: [{ id: 'pi', enabled: true, available: true, reason: null, capabilities: { resume: true } }],
      codex: { ...agentOperations.codex, enabled: false, version: null },
      pi: { enabled: true, version: '0.85.1', model: 'test-model', modelProvider: 'test-source',
        configurationDirectoryConfigured: true, authFileReadable: true, latestRun: null },
    });
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent 运维/ }));
    expect(await screen.findByText('项目 Agent 服务可用')).toBeInTheDocument();
    expect(screen.getByText('0.85.1')).toBeInTheDocument();
    expect(screen.getByText('test-source · test-model')).toBeInTheDocument();
    expect(screen.getByText(/认证文件可读/)).toBeInTheDocument();
  });

  it('warns when the default provider is unavailable despite a healthy alternative', async () => {
    api.getAgentOperations.mockResolvedValue({ ...agentOperations, defaultProvider: 'pi' });
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent 运维/ }));
    expect(await screen.findByText('Agent 已启用，默认 Provider pi 尚不可用')).toBeInTheDocument();
  });

  it('keeps core controls usable when optional modules fail', async () => {
    api.getAgentOperations.mockRejectedValue(new Error('Agent unavailable'));
    api.getPublicAccessStatus.mockRejectedValue(new Error('Tunnel unavailable'));
    api.getBackendRestartStatus.mockResolvedValue({ available: true, reason: null });
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);
    expect(await screen.findByText('所有核心服务运行正常')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重启后端/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /配置与密钥/ }));
    expect(screen.getByPlaceholderText(/搜索/)).toBeInTheDocument();
    expect(screen.queryByText('无法读取管理台状态')).not.toBeInTheDocument();
  });

  it('allows configuration access even if overview fails', async () => {
    api.getAdminOverview.mockRejectedValue(new Error('overview unavailable'));
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);
    await screen.findByText('无法读取管理台状态');
    fireEvent.click(screen.getByRole('button', { name: /配置与密钥/ }));
    expect(screen.getByPlaceholderText(/搜索/)).toBeInTheDocument();
  });

  it('prefills ordinary values and refreshes the configuration after saving', async () => {
    const item = { key: 'DB_HOST', label: 'MySQL 地址', category: 'database',
      description: '数据库地址', secret: false, configured: true, maskedValue: 'old-host',
      editable: true, restartRequired: true, restartScope: 'db', inputType: 'text' };
    api.getAdminConfig.mockResolvedValueOnce([item]).mockResolvedValue([{ ...item, maskedValue: 'new-host' }]);
    api.updateAdminConfig.mockResolvedValue({ updatedKeys: ['DB_HOST'], restartRequired: true, message: '保存成功' });
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /配置与密钥/ }));
    fireEvent.click(await screen.findByRole('button', { name: '更新' }));
    const input = screen.getByDisplayValue('old-host');
    fireEvent.change(input, { target: { value: 'new-host' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    expect(await screen.findByText('new-host')).toBeInTheDocument();
    expect(api.getAdminConfig).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never prefills masked business secrets', async () => {
    api.getAdminConfig.mockResolvedValue([{ key: 'DB_PASSWORD', label: 'MySQL 密码', category: 'database',
      description: '业务密码', secret: true, configured: true, maskedValue: '••••abcd',
      editable: true, restartRequired: true, restartScope: 'db' }]);
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /配置与密钥/ }));
    fireEvent.click(await screen.findByRole('button', { name: '更新' }));
    expect(screen.getByLabelText('输入新密钥')).toHaveValue('');
  });

  it('saves Pi from the provider selector', async () => {
    api.getAdminConfig.mockResolvedValue([{ key: 'AGENT_PROVIDER', label: '默认研究 Provider', category: 'ai',
      description: '选择新对话使用的 Provider', secret: false, configured: true, maskedValue: 'claude',
      editable: true, restartRequired: true, restartScope: 'backend', inputType: 'text',
      options: [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }, { value: 'pi', label: 'Pi' }],
    }]);
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /配置与密钥/ }));
    fireEvent.click(await screen.findByRole('button', { name: '更新' }));
    const selector = screen.getByLabelText('选择选项');
    expect(selector).toHaveValue('claude');
    fireEvent.change(selector, { target: { value: 'pi' } });
    fireEvent.submit(selector.closest('form')!);
    await waitFor(() => expect(api.updateAdminConfig).toHaveBeenCalledWith('test-token', { AGENT_PROVIDER: 'pi' }));
  });

  it('renders the healthy Agent workspace with five metric cards', async () => {
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('所有核心服务运行正常')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Agent 运维/ }));
    expect(await screen.findByText('项目 Agent 服务可用')).toBeInTheDocument();
    const agentGrid = screen.getByLabelText('Agent 运行指标');

    expect(screen.getByText('Claude 运行环境')).toBeInTheDocument();
    expect(screen.getByText('2.0.0')).toBeInTheDocument();
    expect(agentGrid.className).toContain('metric-grid--agent');
    expect(agentGrid.querySelectorAll('.metric-card')).toHaveLength(5);
  });

  it('shows a retryable empty failure state when the first read fails', async () => {
    api.getAdminOverview.mockRejectedValueOnce(new Error('模拟连接失败'));
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/模拟连接失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新连接/ })).toBeInTheDocument();
  });

  it('recovers an initially failed overview automatically without rerunning optional probes', async () => {
    api.getAdminOverview.mockRejectedValueOnce(new Error('request timed out'));
    render(<AdminShell token="test-token" onLogout={vi.fn()} />);
    await screen.findByText('无法读取管理台状态');
    // Becoming visible triggers the same recovery callback as the scheduled retry.
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('所有核心服务运行正常')).toBeInTheDocument();
    expect(screen.queryByText(/request timed out/)).not.toBeInTheDocument();
    expect(api.getAdminOverview).toHaveBeenCalledTimes(2);
    expect(api.getAgentOperations).toHaveBeenCalledTimes(1);
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
