import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DownOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  GlobalOutlined,
  HddOutlined,
  KeyOutlined,
  LockOutlined,
  LogoutOutlined,
  MenuOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  UpOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  AdminApiError,
  getAdminConfig,
  getAdminHealth,
  getAdminOverview,
  getAdminStatus,
  getAgentOperations,
  getBackendRestartStatus,
  getDataUpdateProgress,
  getDatabaseBackupExport,
  getMetricsHistory,
  getPublicAccessStatus,
  restartBackend,
  startDatabaseBackupExport,
  downloadDatabaseBackupExport,
  updateAdminConfig,
  updatePublicAccess,
  verifyAdminToken,
  waitForBackendRecovery,
} from './api';
import type { AdminConfigItem, AdminHealth, AdminOverview, AgentOperations, BackendRestartStatus, DatabaseBackupExportStatus, DataUpdateProgressItem, DiagnosticCheck, HealthLevel, MetricSample, PublicAccessStatus } from './types';
import { sanitizeSecretReplacement } from './secretInput';
import { DataUpdateMessage } from './DataUpdateMessage';

type Section = 'overview' | 'agents' | 'diagnostics' | 'configuration';

const TOKEN_STORAGE_KEY = 'quant-admin-token';
const CATEGORY_LABELS: Record<AdminConfigItem['category'], string> = {
  access: '访问控制',
  database: '数据库',
  ai: '大模型',
  market: '行情数据',
  runtime: '研究运行时',
};

const RESTART_SCOPE_LABELS: Record<AdminConfigItem['restartScope'], string> = {
  db: '需重启后端 · 数据库',
  ai: '需重启后端 · AI',
  runtime: '需重启后端 · 运行时',
  market: '部分即时 / 部分重启',
  access: '需重启后端',
};

const FUND_FLOW_CONFIG_KEYS = new Set([
  'TINYSHARE_TOKEN',
  'FUND_FLOW_UPDATE_TIME',
  'FUND_FLOW_RETRY_TIME',
]);

/** 前端实时校验，与 server/src/admin/envConfig.ts validateEnvValue 规则一致（见 §4.3） */
function validateConfigValue(
  key: string,
  value: string,
  inputType?: AdminConfigItem['inputType'],
): string | null {
  if (key.endsWith('_TIME') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return `${key} 必须使用 HH:mm 格式，例如 18:30`;
  }
  if (['DB_HOST', 'DB_USER', 'DB_NAME', 'OPENAI_MODEL'].includes(key) && !value.trim()) {
    return `${key} 不能为空`;
  }
  if (key === 'OPENAI_MODEL') {
    const models = value.split(';').map((item) => item.trim());
    if (models.some((item) => !item)) return '模型之间使用英文分号分隔，不能包含空模型项';
    if (models.length > 20) return '最多配置 20 个模型';
    if (new Set(models).size !== models.length) return '模型列表不能包含重复项';
  }
  if (key === 'DB_PORT') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return 'DB_PORT 必须是 1 到 65535 的整数';
    }
  }
  if (inputType === 'boolean' && !['true', 'false'].includes(value)) {
    return `${key} 只能是 true 或 false`;
  }
  if (key === 'DUCKDB_MAX_CONCURRENT') {
    const concurrency = Number(value);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      return 'DUCKDB_MAX_CONCURRENT 必须是 1 到 8 的整数';
    }
  }
  if (key === 'DUCKDB_MAX_QUEUED') {
    const queued = Number(value);
    if (!Number.isInteger(queued) || queued < 0 || queued > 100) {
      return 'DUCKDB_MAX_QUEUED 必须是 0 到 100 的整数';
    }
  }
  if (key === 'DUCKDB_MAX_TEMP_SIZE' && !/^\d+(?:\.\d+)?(?:KB|MB|GB|TB)$/i.test(value)) {
    return 'DUCKDB_MAX_TEMP_SIZE 必须使用容量格式，例如 50GB';
  }
  if (key === 'OPENAI_BASE_URL' && value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      return 'OPENAI_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址';
    }
  }
  return null;
}

function App() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '');
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState('');
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    let active = true;
    void getAdminStatus()
      .then(async (status) => {
        if (!active) return;
        setEnabled(status.enabled);
        if (status.enabled && token) {
          try {
            await verifyAdminToken(token);
            if (active) setAuthenticated(true);
          } catch {
            sessionStorage.removeItem(TOKEN_STORAGE_KEY);
            if (active) setToken('');
          }
        }
      })
      .catch((error) => {
        if (active) setAuthError(error instanceof Error ? error.message : '无法读取管理 API 状态');
      })
      .finally(() => {
        if (active) setCheckingAuth(false);
      });
    return () => { active = false; };
  }, []);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setCheckingAuth(true);
    setAuthError('');
    try {
      await verifyAdminToken(token);
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      setAuthenticated(true);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '验证失败');
    } finally {
      setCheckingAuth(false);
    }
  };

  if (checkingAuth && enabled === null) return <LoadingScreen label="正在连接管理 API" />;
  if (!authenticated) {
    return (
      <LoginScreen
        enabled={enabled}
        token={token}
        error={authError}
        loading={checkingAuth}
        onTokenChange={setToken}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <AdminShell
      token={token}
      onLogout={() => {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        setAuthenticated(false);
        setToken('');
      }}
    />
  );
}

export function AdminShell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [section, setSection] = useState<Section>('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [config, setConfig] = useState<AdminConfigItem[]>([]);
  const [agentOperations, setAgentOperations] = useState<AgentOperations | null>(null);
  const [metrics, setMetrics] = useState<MetricSample[]>([]);
  const [dataUpdates, setDataUpdates] = useState<DataUpdateProgressItem[]>([]);
  const [backupExport, setBackupExport] = useState<DatabaseBackupExportStatus | null>(null);
  const [backupStarting, setBackupStarting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editing, setEditing] = useState<AdminConfigItem | null>(null);
  const [notice, setNotice] = useState('');
  const [configSearch, setConfigSearch] = useState('');
  const [restartStatus, setRestartStatus] = useState<BackendRestartStatus | null>(null);
  const [publicAccess, setPublicAccess] = useState<PublicAccessStatus | null>(null);
  const [publicAccessUpdating, setPublicAccessUpdating] = useState(false);
  const [publicAccessPending, setPublicAccessPending] = useState<boolean | null>(null);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const prevOverallRef = useRef<HealthLevel | null>(null);

  const notifyCritical = useCallback(() => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification('Quant Ops 告警', { body: '系统状态已转为 critical，请立即检查。' });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          new Notification('Quant Ops 告警', { body: '系统状态已转为 critical，请立即检查。' });
        }
      });
    }
  }, []);

  // §2 全量刷新（页面加载 / 手动刷新时调用）
  const refreshOverview = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextOverview, nextConfig, nextRestartStatus, nextPublicAccess, nextAgentOperations] = await Promise.all([
        getAdminOverview(token),
        getAdminConfig(token),
        getBackendRestartStatus(token),
        getPublicAccessStatus(token),
        getAgentOperations(token),
      ]);
      setOverview(nextOverview);
      setConfig(nextConfig);
      setRestartStatus(nextRestartStatus);
      setPublicAccess(nextPublicAccess);
      setAgentOperations(nextAgentOperations);
      setLastRefresh(new Date());
      prevOverallRef.current = nextOverview.overall;
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : '刷新失败';
      setError(message);
      if (refreshError instanceof AdminApiError && refreshError.status === 401) onLogout();
    } finally {
      setLoading(false);
    }
  }, [onLogout, token]);

  // §2 轻量健康轮询（15 秒间隔，只调 /health）
  const refreshHealth = useCallback(async (silent = false) => {
    if (!silent) setError('');
    try {
      const health = await getAdminHealth(token);
      setOverview((prev) => prev ? {
        ...prev,
        overall: health.overall,
        counts: health.counts,
        service: health.service,
        database: health.database,
        duckdb: health.duckdb,
        generatedAt: health.generatedAt,
        durationMs: health.durationMs,
      } : prev);
      setLastRefresh(new Date());
      // §4.2 告警：overall 转为 critical 时发送浏览器通知
      if (health.overall === 'critical' && prevOverallRef.current !== 'critical') {
        notifyCritical();
      }
      prevOverallRef.current = health.overall;
    } catch (refreshError) {
      if (!silent) {
        const message = refreshError instanceof Error ? refreshError.message : '刷新失败';
        setError(message);
      }
      if (refreshError instanceof AdminApiError && refreshError.status === 401) onLogout();
    }
  }, [onLogout, token, notifyCritical]);

  // §4.1 趋势数据刷新
  const refreshMetrics = useCallback(async () => {
    try {
      const response = await getMetricsHistory(token);
      setMetrics(response.samples);
    } catch {
      // 静默失败，不影响主流程
    }
  }, [token]);

  const refreshDataUpdates = useCallback(async () => {
    try {
      const response = await getDataUpdateProgress(token);
      setDataUpdates(response.items);
    } catch {
      // Keep the last useful snapshot during a brief backend restart or network outage.
    }
  }, [token]);

  const refreshBackupExport = useCallback(async () => {
    try {
      setBackupExport(await getDatabaseBackupExport(token));
    } catch {
      // Keep the last snapshot during transient outages.
    }
  }, [token]);

  const createBackupExport = useCallback(async () => {
    if (backupStarting || backupExport?.status === 'running') return;
    setBackupStarting(true);
    setError('');
    try {
      setBackupExport(await startDatabaseBackupExport(token));
      setNotice('数据库备份已在后台开始导出，完成后可直接下载 SQL 文件。');
    } catch (backupError) {
      setError(backupError instanceof Error ? backupError.message : '数据库备份导出失败');
    } finally {
      setBackupStarting(false);
    }
  }, [backupExport?.status, backupStarting, token]);

  const downloadBackupExport = useCallback(async () => {
    if (!backupExport?.id || !backupExport.fileName) return;
    setError('');
    try {
      await downloadDatabaseBackupExport(token, backupExport.id, backupExport.fileName);
      setNotice(`数据库备份 ${backupExport.fileName} 已开始下载。`);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : '数据库备份下载失败');
    }
  }, [backupExport, token]);

  useEffect(() => {
    void refreshOverview();
    void refreshDataUpdates();
    void refreshBackupExport();
    const healthTimer = window.setInterval(() => void refreshHealth(true), 15_000);
    const metricsTimer = window.setInterval(() => void refreshMetrics(), 30_000);
    const dataUpdateTimer = window.setInterval(() => void refreshDataUpdates(), 2_000);
    const backupTimer = window.setInterval(() => void refreshBackupExport(), 3_000);
    return () => {
      window.clearInterval(healthTimer);
      window.clearInterval(metricsTimer);
      window.clearInterval(dataUpdateTimer);
      window.clearInterval(backupTimer);
    };
  }, [refreshOverview, refreshHealth, refreshMetrics, refreshDataUpdates, refreshBackupExport]);

  const navigate = (next: Section) => {
    setSection(next);
    setSidebarOpen(false);
  };

  const performRestart = async () => {
    if (!overview || restarting) return;
    setRestartDialogOpen(false);
    setRestarting(true);
    setError('');
    setNotice('后端正在优雅关闭并重新启动，页面会自动等待服务恢复。');
    try {
      const previousPid = overview.service.pid;
      await restartBackend(token);
      const health = await waitForBackendRecovery(token, previousPid);
      setOverview((current) => current ? {
        ...current,
        overall: health.overall,
        counts: health.counts,
        service: health.service,
        database: health.database,
        duckdb: health.duckdb,
        generatedAt: health.generatedAt,
        durationMs: health.durationMs,
      } : current);
      setNotice(`后端已恢复，新进程 PID ${health.service.pid}。`);
      setLastRefresh(new Date());
      await refreshOverview();
    } catch (restartError) {
      setError(restartError instanceof Error ? restartError.message : '后端重启失败');
      setNotice('');
    } finally {
      setRestarting(false);
    }
  };

  const applyPublicAccess = async () => {
    if (publicAccessPending === null || publicAccessUpdating) return;
    const enabled = publicAccessPending;
    setPublicAccessPending(null);
    setPublicAccessUpdating(true);
    setError('');
    try {
      const next = await updatePublicAccess(token, enabled);
      setPublicAccess(next);
      setNotice(enabled
        ? '公网访问已开启，SSH 隧道与 frpc 正在后台运行。'
        : '公网访问已关闭，隧道任务已停止并禁用。');
    } catch (accessError) {
      setError(accessError instanceof Error ? accessError.message : '公网访问配置更新失败');
    } finally {
      setPublicAccessUpdating(false);
    }
  };

  return (
    <div className="admin-shell">
      <aside className={`admin-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="brand-block">
          <div className="brand-mark"><SafetyCertificateOutlined /></div>
          <div>
            <strong>Quant Ops</strong>
            <span>运行保障中心</span>
          </div>
          <button className="icon-button sidebar-close" aria-label="关闭导航" onClick={() => setSidebarOpen(false)}>
            <CloseOutlined />
          </button>
        </div>
        <nav aria-label="管理台导航">
          <NavButton active={section === 'overview'} icon={<DashboardOutlined />} onClick={() => navigate('overview')}>
            运行总览
          </NavButton>
          <NavButton active={section === 'agents'} icon={<RobotOutlined />} onClick={() => navigate('agents')}>
            Agent 运维
            {agentOperations && agentOperations.pendingApprovals > 0 && <span className="nav-count">{agentOperations.pendingApprovals}</span>}
          </NavButton>
          <NavButton active={section === 'diagnostics'} icon={<AlertOutlined />} onClick={() => navigate('diagnostics')}>
            问题诊断
            {overview && overview.counts.critical + overview.counts.warning > 0 && (
              <span className="nav-count">{overview.counts.critical + overview.counts.warning}</span>
            )}
          </NavButton>
          <NavButton active={section === 'configuration'} icon={<KeyOutlined />} onClick={() => navigate('configuration')}>
            配置与密钥
          </NavButton>
        </nav>
        <div className="sidebar-meta">
          <span>自动刷新</span>
          <strong>15 秒 · 健康轮询</strong>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}

      <main className="admin-main">
        <header className="admin-header">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(true)}>
            <MenuOutlined />
          </button>
          <div className="admin-header-copy">
            <span className="eyebrow">Operations Console</span>
            <h1>{section === 'overview' ? '运行总览' : section === 'agents' ? 'Agent 运维' : section === 'diagnostics' ? '问题诊断' : '配置与密钥'}</h1>
          </div>
          <div className="header-actions">
            <div className="refresh-meta">
              <span>上次刷新</span>
              <strong>{lastRefresh ? lastRefresh.toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</strong>
            </div>
            <button
              className="secondary-button restart-trigger"
              disabled={restarting || restartStatus?.available !== true}
              title={restartStatus?.available ? '优雅重启后端服务' : restartStatus?.reason ?? '正在读取重启能力'}
              onClick={() => setRestartDialogOpen(true)}
            >
              <PoweroffOutlined spin={restarting} />
              <span>{restarting ? '重启中' : '重启后端'}</span>
            </button>
            <button className="secondary-button" disabled={loading} onClick={() => void refreshOverview()}>
              <ReloadOutlined spin={loading} />
              <span>刷新</span>
            </button>
            <button className="icon-button" aria-label="退出管理台" title="退出管理台" onClick={onLogout}>
              <LogoutOutlined />
            </button>
          </div>
        </header>

        <div className="admin-content">
          {error && overview && <InlineMessage level="critical">{error}</InlineMessage>}
          {notice && <InlineMessage level="warning" onClose={() => setNotice('')}>{notice}</InlineMessage>}
          {/* §4.2 critical 常驻横幅 */}
          {overview?.overall === 'critical' && (
            <InlineMessage level="critical">
              <AlertOutlined /> 系统当前处于 critical 状态，请立即检查下方诊断项。
            </InlineMessage>
          )}
          {loading && !overview ? (
            <DashboardSkeleton />
          ) : !overview ? (
            <AdminLoadFailure error={error || '暂时无法读取管理台状态。'} onRetry={() => void refreshOverview()} />
          ) : section === 'overview' ? (
            <OverviewSection
              overview={overview}
              metrics={metrics}
              dataUpdates={dataUpdates}
              backupExport={backupExport}
              backupStarting={backupStarting}
              onStartBackup={() => void createBackupExport()}
              onDownloadBackup={() => void downloadBackupExport()}
              onRefreshMetrics={() => void refreshMetrics()}
            />
          ) : section === 'agents' ? (
            agentOperations ? <AgentOperationsSection operations={agentOperations} /> : <SectionLoadFailure label="Agent 运维数据暂不可用" />
          ) : section === 'diagnostics' ? (
            <DiagnosticsSection checks={overview.checks} />
          ) : (
            <ConfigurationSection
              items={config}
              publicAccess={publicAccess}
              publicAccessUpdating={publicAccessUpdating}
              onTogglePublicAccess={(enabled) => setPublicAccessPending(enabled)}
              fundFlowProgress={dataUpdates.find((item) => item.key === 'fund_flow') ?? null}
              onEdit={setEditing}
              search={configSearch}
              onSearchChange={setConfigSearch}
            />
          )}
        </div>
      </main>

      {editing && (
        <ConfigDialog
          item={editing}
          token={token}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            setNotice(message);
            await refreshHealth(true);
          }}
        />
      )}
      {restartDialogOpen && overview && (
        <RestartDialog
          pid={overview.service.pid}
          onCancel={() => setRestartDialogOpen(false)}
          onConfirm={() => void performRestart()}
        />
      )}
      {publicAccessPending !== null && (
        <PublicAccessDialog
          enabled={publicAccessPending}
          onCancel={() => setPublicAccessPending(null)}
          onConfirm={() => void applyPublicAccess()}
        />
      )}
    </div>
  );
}

function RestartDialog({ pid, onCancel, onConfirm }: { pid: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="config-dialog restart-dialog" role="alertdialog" aria-modal="true" aria-labelledby="restart-dialog-title" aria-describedby="restart-dialog-description">
        <div className="restart-dialog-icon"><PoweroffOutlined /></div>
        <span className="eyebrow">Backend restart</span>
        <h2 id="restart-dialog-title">确认重启后端？</h2>
        <p id="restart-dialog-description">当前进程 PID {pid} 将先停止接收请求，关闭调度器和数据库连接，再由监督进程重新启动。预计短暂不可用 3—15 秒。</p>
        <div className="restart-impact"><WarningOutlined /> 正在执行的后端请求可能中断，请确认当前没有重要导入或回测任务。</div>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
          <button type="button" className="danger-button" autoFocus onClick={onConfirm}><PoweroffOutlined />确认重启</button>
        </div>
      </section>
    </div>
  );
}

function AgentOperationsSection({ operations }: { operations: AgentOperations }) {
  const codexProvider = operations.providers.find(provider => provider.id === 'codex');
  const status: HealthLevel = !operations.enabled ? 'disabled'
    : codexProvider?.available ? 'healthy' : 'warning';
  return <>
    <section className={`system-banner status-surface-${status}`}>
      <div className="banner-status-icon"><RobotOutlined /></div>
      <div className="banner-copy">
        <span className="eyebrow">Codex Harness</span>
        <h2>{operations.enabled ? (codexProvider?.available ? '项目 Agent 服务可用' : 'Agent 已启用，Codex 尚不可用') : 'Agent 系统当前关闭'}</h2>
        <p>默认 Provider：{operations.defaultProvider} · 活跃 {operations.runtime.active}/{operations.runtime.capacity} · 待审批 {operations.pendingApprovals}</p>
      </div>
      <StatusBadge level={status} />
    </section>
    <div className="metric-grid metric-grid--agent" aria-label="Agent 运行指标">
      <MetricCard icon={<RobotOutlined />} label="Codex CLI" value={operations.codex.version ?? '不可用'} detail={operations.codex.model ?? '未指定模型'} level={operations.codex.version ? 'healthy' : 'warning'} />
      <MetricCard icon={<CloudServerOutlined />} label="API Provider" value={operations.codex.modelProvider} detail={operations.codex.apiKeyConfigured ? '项目 Key 已配置' : '项目 Key 未配置'} level={operations.codex.apiKeyConfigured ? 'healthy' : 'critical'} />
      <MetricCard icon={<SafetyCertificateOutlined />} label="工作区自治" value={operations.codex.sandboxMode} detail={`Windows ${operations.codex.windowsSandbox} · 审批 ${operations.codex.approvalsEnabled ? '逐步开启' : '无需逐步审批'} · 网络 ${operations.codex.networkEnabled ? '开放' : '关闭'}`} level={operations.codex.isolatedHome && operations.codex.sandboxMode === 'workspace-write' && !operations.codex.approvalsEnabled ? 'healthy' : 'warning'} />
      <MetricCard icon={<DatabaseOutlined />} label="行情数据入口" value={operations.codex.marketDataCliConfigured ? '本地优先' : '未配置'} detail={`外部补缺 ${operations.codex.externalDataSkillEnabled ? '已启用' : '已关闭'} · 隔离 Python ${operations.codex.isolatedPythonConfigured ? '可用' : '未配置'}`} level={operations.codex.marketDataCliConfigured && operations.codex.isolatedPythonConfigured ? 'healthy' : 'warning'} />
      <MetricCard icon={<BarChartOutlined />} label="持久化事件" value={String(operations.persistence?.events ?? 0)} detail={`${operations.persistence?.conversations ?? 0} 个对话`} level="healthy" />
    </div>
    <Panel title="Provider 状态" subtitle="能力、可用性与运行容量" icon={<CloudServerOutlined />}>
      {operations.providers.length ? operations.providers.map(provider => <div className="resource-row" key={provider.id}>
        <div><strong>{provider.id}</strong><span>{provider.reason ?? Object.entries(provider.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(' · ')}</span></div>
        <StatusBadge level={provider.available ? 'healthy' : provider.enabled ? 'warning' : 'disabled'} compact />
      </div>) : <EmptyState icon={<RobotOutlined />} title="Provider 未启动" description="启用 Agent 并重启后端后可查看实时 Provider 状态。" />}
    </Panel>
    <Panel title="近期失败" subtitle="仅展示脱敏错误分类，不包含提示词、推理或密钥" icon={<AlertOutlined />}>
      {operations.recentFailures.length ? operations.recentFailures.map(failure => <div className="resource-row" key={failure.runId}>
        <div><strong>{failure.provider} · {failure.category} · {failure.errorCode}</strong><span>{failure.message}{failure.finishedAt ? ` · ${new Date(failure.finishedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</span></div>
        <StatusBadge level="critical" compact />
      </div>) : <EmptyState icon={<CheckCircleOutlined />} title="没有近期失败" description="最近 50 次运行中未发现失败任务。" />}
    </Panel>
  </>;
}

function PublicAccessDialog({ enabled, onCancel, onConfirm }: {
  enabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section className="config-dialog restart-dialog" role="alertdialog" aria-modal="true" aria-labelledby="public-access-dialog-title">
        <div className="restart-dialog-icon"><GlobalOutlined /></div>
        <span className="eyebrow">Public access</span>
        <h2 id="public-access-dialog-title">{enabled ? '确认开启公网访问？' : '确认关闭公网访问？'}</h2>
        <p>{enabled
          ? '系统将启用并启动 SSH 隧道和 frpc，stock.clical.xin 会重新对互联网开放。'
          : '系统将停止并禁用 SSH 隧道和 frpc，所有公网用户会立即断开；本地访问不受影响。'}</p>
        <div className="restart-impact"><WarningOutlined /> 此操作会立即改变公网可达性，请确认当前业务状态允许切换。</div>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
          <button className={enabled ? 'primary-button' : 'danger-button'} type="button" onClick={onConfirm}>
            {enabled ? '确认开启' : '确认关闭'}
          </button>
        </div>
      </section>
    </div>
  );
}

function OverviewSection({ overview, metrics, dataUpdates, backupExport, backupStarting, onStartBackup, onDownloadBackup, onRefreshMetrics }: {
  overview: AdminOverview;
  metrics: MetricSample[];
  dataUpdates: DataUpdateProgressItem[];
  backupExport: DatabaseBackupExportStatus | null;
  backupStarting: boolean;
  onStartBackup: () => void;
  onDownloadBackup: () => void;
  onRefreshMetrics: () => void;
}) {
  const connectionUsage = overview.database.maxConnections && overview.database.threadsConnected != null
    ? overview.database.threadsConnected / overview.database.maxConnections
    : null;
  const heapUsage = overview.service.memory.heapTotalBytes > 0
    ? overview.service.memory.heapUsedBytes / overview.service.memory.heapTotalBytes
    : 0;
  const issueCount = overview.counts.critical + overview.counts.warning;

  // §4.1 sparkline 数据提取
  const rssData = metrics.map((m) => m.rssBytes);
  const dbLatencyData = metrics.filter((m) => m.databaseLatencyMs != null).map((m) => m.databaseLatencyMs!);
  const diskData = metrics.filter((m) => m.diskUsedPercent != null).map((m) => m.diskUsedPercent!);
  const queueData = metrics.map((m) => m.duckdbQueued);
  const heapData = metrics.map((m) => m.heapUsedBytes);
  const sparkColor = 'var(--accent-primary)';

  return (
    <>
      <section className={`system-banner status-surface-${overview.overall}`}>
        <div className="banner-status-icon"><StatusIcon level={overview.overall} /></div>
        <div>
          <span className="eyebrow">System status</span>
          <h2>{overview.overall === 'healthy' ? '所有核心服务运行正常' : `发现 ${issueCount} 个需要关注的问题`}</h2>
          <p>诊断耗时 {overview.durationMs}ms · 后端已运行 {formatDuration(overview.service.uptimeSeconds)}</p>
        </div>
        <StatusBadge level={overview.overall} />
      </section>

      <DataUpdateProgressPanel items={dataUpdates} />

      <DatabaseBackupPanel
        status={backupExport}
        starting={backupStarting}
        onStart={onStartBackup}
        onDownload={onDownloadBackup}
      />

      <section className="metric-grid" aria-label="核心运行指标">
        <MetricCard
          icon={<CloudServerOutlined />}
          label="后端服务"
          value={formatBytes(overview.service.memory.rssBytes)}
          detail={`RSS 内存 · PID ${overview.service.pid}`}
          level="healthy"
          progress={heapUsage}
          sparkline={<Sparkline data={rssData} color={sparkColor} />}
        />
        <MetricCard
          icon={<DatabaseOutlined />}
          label="MySQL"
          value={overview.database.latencyMs == null ? '不可用' : `${overview.database.latencyMs}ms`}
          detail={overview.database.version ? `MySQL ${overview.database.version}` : '连接失败'}
          level={overview.database.status}
          progress={connectionUsage ?? undefined}
          sparkline={<Sparkline data={dbLatencyData} color={sparkColor} />}
        />
        <MetricCard
          icon={<HddOutlined />}
          label="数据磁盘"
          value={overview.storage.disk ? `${Math.round(overview.storage.disk.usedPercent * 100)}%` : '未知'}
          detail={overview.storage.disk ? `剩余 ${formatBytes(overview.storage.disk.freeBytes)}` : '无法读取容量'}
          level={overview.storage.disk && overview.storage.disk.usedPercent >= 0.9
            ? 'critical' : overview.storage.disk && overview.storage.disk.usedPercent >= 0.8 ? 'warning' : 'healthy'}
          progress={overview.storage.disk?.usedPercent}
          sparkline={<Sparkline data={diskData} color={sparkColor} />}
        />
        <MetricCard
          icon={<ClockCircleOutlined />}
          label="DuckDB 会话"
          value={`${overview.duckdb.active} / ${overview.duckdb.limit}`}
          detail={overview.duckdb.queued > 0 ? `${overview.duckdb.queued} 个查询排队` : '当前无等待查询'}
          level={overview.duckdb.queued > 0 ? 'warning' : 'healthy'}
          progress={overview.duckdb.limit > 0 ? overview.duckdb.active / overview.duckdb.limit : 0}
          sparkline={<Sparkline data={queueData} color={sparkColor} />}
        />
      </section>

      {/* §4.1 最近 1 小时趋势 */}
      {metrics.length >= 2 && (
        <Panel title="最近 1 小时趋势" subtitle={`${metrics.length} 个采样点`} icon={<DashboardOutlined />}>
          <div className="sparkline-grid">
            <div className="sparkline-cell">
              <span className="sparkline-label">RSS 内存</span>
              <Sparkline data={rssData} color="var(--accent-primary)" width={200} height={40} />
            </div>
            <div className="sparkline-cell">
              <span className="sparkline-label">堆使用</span>
              <Sparkline data={heapData} color="var(--accent-primary)" width={200} height={40} />
            </div>
            <div className="sparkline-cell">
              <span className="sparkline-label">磁盘使用率</span>
              <Sparkline data={diskData} color="var(--status-warning)" width={200} height={40} />
            </div>
            <div className="sparkline-cell">
              <span className="sparkline-label">DuckDB 队列</span>
              <Sparkline data={queueData} color="var(--accent-primary)" width={200} height={40} />
            </div>
          </div>
        </Panel>
      )}

      <section className="dashboard-columns">
        <Panel title="数据基础设施" subtitle="关键目录与发布清单状态" icon={<HddOutlined />}>
          <div className="resource-list">
            {overview.storage.roots.map((root) => (
              <div className="resource-row" key={root.id}>
                <div>
                  <strong>{root.label}</strong>
                  <span title={root.path}>{root.path}</span>
                </div>
                <StatusBadge
                  level={root.available && root.manifestAvailable !== false ? 'healthy' : root.id === 'snapshot' ? 'critical' : 'warning'}
                  compact
                />
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="任务概况" subtitle="同步与自动因子挖掘历史状态" icon={<ClockCircleOutlined />}>
          <TaskSummary title="行情同步" counts={overview.tasks.syncJobs} />
          <TaskSummary title="因子挖掘" counts={overview.tasks.miningTasks} />
        </Panel>
      </section>

      <section className="dashboard-columns">
        <Panel title="数据血缘" subtitle="MySQL → 研究快照 → 分钟数据湖" icon={<DatabaseOutlined />}>
          <div className="resource-list">
            <LineageRow
              label="MySQL 权威日期"
              value={overview.dataGovernance.lineage.mysqlAuthoritativeDate}
            />
            <LineageRow
              label="研究快照"
              value={overview.dataGovernance.lineage.snapshotMaxDate}
              detail={overview.dataGovernance.lineage.snapshotId ?? undefined}
            />
            <LineageRow
              label="分钟数据湖"
              value={overview.dataGovernance.lineage.minuteMaxDate}
              detail={overview.dataGovernance.lineage.minutePreparedAt ?? undefined}
            />
          </div>
        </Panel>

        <Panel title="覆盖率矩阵" subtitle="核心数据库与研究数据域覆盖情况" icon={<SafetyCertificateOutlined />}>
          {overview.dataGovernance.coverage ? (
            <div className="resource-list">
              {overview.dataGovernance.coverage.rows.map((row) => (
                <div className="resource-row" key={row.key}>
                  <div>
                    <strong>{row.label}</strong>
                    <span>{row.message} · {row.minDate ?? '—'} ~ {row.maxDate ?? '—'}</span>
                  </div>
                  <StatusBadge
                    level={row.status === 'pass' ? 'healthy' : row.status === 'warn' ? 'warning' : 'critical'}
                    compact
                  />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<WarningOutlined />} title="覆盖率不可用" description="MySQL 离线或覆盖检查执行失败。" />
          )}
        </Panel>

        <Panel title="市场采集健康" subtitle="龙虎榜时点、新闻心跳与来源抓取" icon={<ClockCircleOutlined />}>
          {overview.dataGovernance.collectorHealth ? (
            <div className="resource-list">
              {overview.dataGovernance.collectorHealth.checks.map((check) => (
                <div className="resource-row" key={check.key}>
                  <div>
                    <strong>{check.key === 'dragon_tiger_freshness' ? '龙虎榜新鲜度' : check.key === 'market_news_collector_heartbeat' ? '新闻采集心跳' : '新闻来源成功率'}</strong>
                    <span>{check.message}</span>
                  </div>
                  <StatusBadge
                    level={check.status === 'pass' ? 'healthy' : check.status === 'warn' ? 'warning' : 'critical'}
                    compact
                  />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<WarningOutlined />} title="采集健康不可用" description="MySQL 离线或采集状态查询失败。" />
          )}
        </Panel>
      </section>

      {overview.dataGovernance.materialized && (
        <Panel title="持久研究结果" subtitle="按研究快照识别过期 DuckDB/Parquet 物化结果" icon={<HddOutlined />}>
          <div className="task-tags">
            <span><code>current</code>{overview.dataGovernance.materialized.current}</span>
            <span><code>stale</code>{overview.dataGovernance.materialized.stale}</span>
            <span><code>invalid</code>{overview.dataGovernance.materialized.invalid}</span>
            <span><code>stale bytes</code>{formatBytes(overview.dataGovernance.materialized.staleBytes)}</span>
          </div>
        </Panel>
      )}

      <Panel title="优先处理" subtitle="按严重程度汇总当前诊断结果" icon={<AlertOutlined />}>
        {overview.checks.filter((item) => item.level === 'critical' || item.level === 'warning').length === 0 ? (
          <EmptyState icon={<CheckCircleOutlined />} title="没有待处理问题" description="系统配置、数据库和数据目录均通过当前检查。" />
        ) : (
          <div className="issue-list compact">
            {overview.checks
              .filter((item) => item.level === 'critical' || item.level === 'warning')
              .slice(0, 5)
              .map((check) => <IssueCard check={check} key={check.id} />)}
          </div>
        )}
      </Panel>
    </>
  );
}

function DatabaseBackupPanel({ status, starting, onStart, onDownload }: {
  status: DatabaseBackupExportStatus | null;
  starting: boolean;
  onStart: () => void;
  onDownload: () => void;
}) {
  const running = starting || status?.status === 'running';
  const level: HealthLevel = status?.status === 'failed'
    ? 'critical' : status?.status === 'completed' ? 'healthy' : running ? 'warning' : 'disabled';
  return (
    <Panel title="数据库备份" subtitle="导出完整 MySQL SQL 文件 · 单事务一致性快照 · SHA-256 校验" icon={<DatabaseOutlined />}>
      <div className={`database-backup-row status-surface-${level}`} aria-live="polite">
        <div className="database-backup-copy">
          <div className="database-backup-title">
            <strong>{running ? '正在后台导出' : status?.status === 'completed' ? '最近备份可下载' : status?.status === 'failed' ? '最近导出失败' : '尚未导出备份'}</strong>
            <StatusBadge level={level} compact />
          </div>
          {status?.status === 'completed' ? (
            <p>{status.fileName} · {status.bytes == null ? '未知大小' : formatBytes(status.bytes)} · SHA-256 {status.sha256?.slice(0, 12)}…</p>
          ) : status?.status === 'failed' ? (
            <p className="database-backup-error">{status.error}</p>
          ) : (
            <p>{running ? '浏览器可以离开本页；后台会继续执行，状态每 3 秒刷新。' : '备份保存在服务器备份目录，完成后可下载到本机。'}</p>
          )}
          {status?.updatedAt && <small>更新时间：{new Date(status.updatedAt).toLocaleString('zh-CN', { hour12: false })}</small>}
        </div>
        <div className="database-backup-actions">
          <button className="primary-button" disabled={running} onClick={onStart}>
            <DatabaseOutlined />{running ? '正在导出…' : '导出新备份'}
          </button>
          <button className="secondary-button" disabled={status?.status !== 'completed'} onClick={onDownload}>
            <DownloadOutlined />下载 SQL
          </button>
        </div>
      </div>
    </Panel>
  );
}

export function DataUpdateProgressPanel({ items }: { items: DataUpdateProgressItem[] }) {
  const runningCount = items.filter((item) => item.status === 'running' || item.status === 'pending').length;
  const issueCount = items.filter((item) => item.status === 'failed' || item.failed > 0).length;
  return (
    <Panel
      title="数据更新进度"
      subtitle={`每 2 秒刷新 · ${runningCount > 0 ? `${runningCount} 项运行中` : '当前无运行任务'} · ${issueCount > 0 ? `${issueCount} 项需留意` : '未发现异常'}`}
      icon={<ClockCircleOutlined />}
    >
      <div className="data-update-grid" aria-live="polite" aria-atomic="false">
        {items.length === 0 ? (
          <div className="data-update-empty">正在读取后台任务状态…</div>
        ) : items.map((item) => {
          const running = item.status === 'running' || item.status === 'pending';
          const level: HealthLevel = item.status === 'failed'
            ? 'critical' : item.status === 'completed' && item.failed === 0 ? 'healthy' : running || item.failed > 0 ? 'warning' : 'disabled';
          const width = item.percent ?? (running ? 12 : 0);
          const featured = item.key === 'fund_flow';
          return (
            <article
              className={`data-update-card status-surface-${level} ${running ? 'is-running' : ''} ${featured ? 'is-featured' : ''}`}
              key={item.key}
            >
              <div className="data-update-head">
                <div>
                  <strong>{item.label}</strong>
                  <span>{formatUpdatePhase(item.phase)}</span>
                </div>
                <UpdateStatusBadge status={item.status} level={level} />
              </div>
              <div
                className={`data-update-track ${running && item.percent == null ? 'is-indeterminate' : ''}`}
                role="progressbar"
                aria-label={`${item.label}更新进度`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.percent ?? undefined}
                aria-valuetext={item.percent == null ? formatUpdatePhase(item.phase) : `${item.percent}%`}
              >
                <span className={`data-update-fill level-${level}`} style={{ width: `${width}%` }} />
              </div>
              <div className="data-update-meta">
                <span>{item.total > 0
                  ? `${item.completed + item.failed} / ${item.total} · 成功 ${item.completed} · 失败 ${item.failed}`
                  : running ? '等待采集进度' : '未返回数量统计'}</span>
                <strong>{item.percent == null ? '—' : `${item.percent}%`}</strong>
              </div>
              {featured && (item.currentDate || item.processedRows || item.etaAt) && (
                <dl className="data-update-highlights">
                  <div><dt>当前日期</dt><dd>{item.currentDate ?? '—'}</dd></div>
                  <div><dt>累计写入</dt><dd>{item.processedRows ? `${item.processedRows.toLocaleString('zh-CN')} 行` : '—'}</dd></div>
                  <div><dt>预计完成</dt><dd>{item.etaAt ? new Date(item.etaAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '计算中'}</dd></div>
                </dl>
              )}
              <DataUpdateMessage message={item.message} updatedAt={item.updatedAt} />
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

function formatUpdatePhase(phase: string): string {
  const labels: Record<string, string> = {
    idle: '等待任务', starting: '正在启动', preparing: '正在准备',
    'fetching-online': '抓取分钟行情', publishing: '校验并发布', published: '发布完成',
    'up-to-date': '数据已是最新', 'source-stale': '在线数据源滞后',
    'local-fallback': '本地补偿导入', 'fallback-completed': '补偿导入完成',
    pending: '排队准备', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消',
    '采集财务报表': '采集财务报表', '等待财报更新': '等待财报更新',
    '排队准备': '排队准备', '更新行情': '更新个股日 K 行情', '等待计划任务': '等待计划任务', '等待盘后更新': '等待盘后更新',
    'tinyshare-backfill': 'Tinyshare 历史回补', 'akshare-daily': 'AKShare 盘后增量', '等待资金流更新': '等待盘后资金流更新',
  };
  return labels[phase] ?? phase;
}

function UpdateStatusBadge({ status, level }: { status: DataUpdateProgressItem['status']; level: HealthLevel }) {
  const labels: Record<DataUpdateProgressItem['status'], string> = {
    idle: '等待中', pending: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消',
  };
  return (
    <span className={`status-badge level-${level} is-compact`}>
      {status === 'running' || status === 'pending' ? <ClockCircleOutlined /> : <StatusIcon level={level} />}
      {labels[status]}
    </span>
  );
}

function LineageRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | null;
  detail?: string;
}) {
  return (
    <div className="resource-row">
      <div>
        <strong>{label}</strong>
        <span title={detail}>{value ?? '不可用'}{detail ? ` · ${detail}` : ''}</span>
      </div>
      <StatusBadge level={value ? 'healthy' : 'warning'} compact />
    </div>
  );
}

function DiagnosticsSection({ checks }: { checks: DiagnosticCheck[] }) {
  const [filter, setFilter] = useState<'all' | HealthLevel>('all');
  const visible = useMemo(
    () => checks.filter((item) => filter === 'all' || item.level === filter),
    [checks, filter],
  );

  return (
    <Panel title="系统检查结果" subtitle="提供问题原因和建议处理方式" icon={<AlertOutlined />}>
      <div className="filter-bar" role="group" aria-label="诊断结果筛选">
        {([
          ['all', '全部'],
          ['critical', '严重'],
          ['warning', '警告'],
          ['healthy', '正常'],
        ] as const).map(([value, label]) => (
          <button
            type="button"
            className={filter === value ? 'filter-button is-active' : 'filter-button'}
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {visible.length > 0 ? (
        <div className="issue-list">{visible.map((check) => <IssueCard check={check} key={check.id} />)}</div>
      ) : (
        <EmptyState icon={<CheckCircleOutlined />} title="该分类没有检查项" description="切换其他筛选条件查看诊断结果。" />
      )}
    </Panel>
  );
}

function ConfigurationSection({
  items,
  publicAccess,
  publicAccessUpdating,
  onTogglePublicAccess,
  fundFlowProgress,
  onEdit,
  search,
  onSearchChange,
}: {
  items: AdminConfigItem[];
  publicAccess: PublicAccessStatus | null;
  publicAccessUpdating: boolean;
  onTogglePublicAccess: (enabled: boolean) => void;
  fundFlowProgress: DataUpdateProgressItem | null;
  onEdit: (item: AdminConfigItem) => void;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const categories = Object.keys(CATEGORY_LABELS) as AdminConfigItem['category'][];
  const searchLower = search.trim().toLowerCase();
  const matchesSearch = (item: AdminConfigItem) =>
    !searchLower ||
    item.label.toLowerCase().includes(searchLower) ||
    item.key.toLowerCase().includes(searchLower) ||
    item.description.toLowerCase().includes(searchLower);
  return (
    <>
      <div className="config-search-bar">
        <SearchOutlined />
        <label className="sr-only" htmlFor="admin-config-search">搜索配置项</label>
        <input
          id="admin-config-search"
          type="text"
          placeholder="搜索配置项名称、键名或描述…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {search && (
          <button type="button" className="icon-button" aria-label="清除搜索" onClick={() => onSearchChange('')}>
            <CloseOutlined />
          </button>
        )}
      </div>
      <InlineMessage level="warning">
        管理台不会返回密钥明文。修改会写入 server/.env，但已创建的数据库连接、AI Provider 和调度器需要重启后端才能完全生效。
      </InlineMessage>
      <PublicAccessCard
        status={publicAccess}
        updating={publicAccessUpdating}
        onToggle={onTogglePublicAccess}
      />
      {categories.map((category) => {
        const categoryItems = items.filter((item) => item.category === category && matchesSearch(item));
        if (categoryItems.length === 0) return null;
        const fundFlowItems = category === 'market'
          ? categoryItems.filter((item) => FUND_FLOW_CONFIG_KEYS.has(item.key))
          : [];
        const standardItems = categoryItems.filter((item) => !FUND_FLOW_CONFIG_KEYS.has(item.key));
        return (
          <Panel
            key={category}
            title={CATEGORY_LABELS[category]}
            subtitle={`${categoryItems.filter((item) => item.configured).length}/${categoryItems.length} 项已配置`}
            icon={category === 'database' ? <DatabaseOutlined /> : category === 'access' ? <LockOutlined /> : <SettingOutlined />}
          >
            <div className="config-list">
              {fundFlowItems.length > 0 && (
                <>
                  <FundFlowConfigSummary progress={fundFlowProgress} items={fundFlowItems} />
                  <ConfigGroupHeading
                    title="资金流配置"
                    description="主力、超大单、大单、中单和小单资金净流入"
                  />
                  {fundFlowItems.map((item) => <ConfigRow item={item} onEdit={onEdit} key={item.key} />)}
                </>
              )}
              {category === 'market' && fundFlowItems.length > 0 && standardItems.length > 0 && (
                <ConfigGroupHeading title="基础行情配置" description="证券、K 线、分钟数据与财务报表" />
              )}
              {standardItems.map((item) => <ConfigRow item={item} onEdit={onEdit} key={item.key} />)}
            </div>
          </Panel>
        );
      })}
    </>
  );
}

function PublicAccessCard({ status, updating, onToggle }: {
  status: PublicAccessStatus | null;
  updating: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const enabled = status?.enabled === true;
  const healthy = enabled && status?.running === true;
  const label = !status ? '读取中' : !status.available ? '不可用' : healthy ? '已开放' : enabled ? '通道异常' : '已关闭';
  const level: HealthLevel = healthy ? 'healthy' : enabled ? 'warning' : status?.available ? 'disabled' : 'critical';
  return (
    <Panel title="公网访问" subtitle="控制 stock.clical.xin 是否允许从互联网访问" icon={<GlobalOutlined />}>
      <article className={`public-access-card status-surface-${level}`} aria-live="polite">
        <div className="public-access-copy">
          <div className="public-access-title">
            <strong>{status?.domain ?? 'https://stock.clical.xin'}</strong>
            <span className={`status-badge level-${level}`}>{label}</span>
          </div>
          <p>{status?.message ?? (enabled
            ? '公网入口已启用；本地网站、SSH 隧道和 frpc 必须同时保持运行。'
            : '关闭后公网会立即失去访问能力，本地网站与管理后台不受影响。')}</p>
          <div className="public-access-tasks">
            {(status?.tasks ?? []).map((task) => (
              <span key={task.name} className={task.running ? 'is-running' : ''}>
                {task.name} · {task.running ? '运行中' : task.enabled ? task.state : '已禁用'}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={enabled ? 'danger-button' : 'secondary-button'}
          role="switch"
          aria-checked={enabled}
          disabled={!status?.available || updating}
          onClick={() => onToggle(!enabled)}
        >
          <PoweroffOutlined spin={updating} />
          {updating ? '处理中' : enabled ? '关闭公网访问' : '开启公网访问'}
        </button>
      </article>
    </Panel>
  );
}

function FundFlowConfigSummary({ progress, items }: {
  progress: DataUpdateProgressItem | null;
  items: AdminConfigItem[];
}) {
  const running = progress?.status === 'running' || progress?.status === 'pending';
  const level: HealthLevel = progress?.status === 'failed'
    ? 'critical'
    : progress?.status === 'completed' && progress.failed === 0
      ? 'healthy'
      : running || (progress?.failed ?? 0) > 0
        ? 'warning'
        : 'disabled';
  const updateTime = items.find((item) => item.key === 'FUND_FLOW_UPDATE_TIME')?.maskedValue ?? '16:20';
  const retryTime = items.find((item) => item.key === 'FUND_FLOW_RETRY_TIME')?.maskedValue ?? '17:20';
  const percent = progress?.percent ?? 0;

  return (
    <article className={`fund-flow-summary status-surface-${level}`} aria-live="polite">
      <div className="fund-flow-summary-head">
        <div className="fund-flow-summary-title">
          <span className="fund-flow-summary-icon"><BarChartOutlined /></span>
          <div>
            <strong>资金数据</strong>
            <span>Tinyshare 历史回补 · AKShare 每日增量</span>
          </div>
        </div>
        {progress ? (
          <UpdateStatusBadge status={progress.status} level={level} />
        ) : (
          <span className="status-badge level-disabled is-compact"><ClockCircleOutlined />读取中</span>
        )}
      </div>
      <div
        className={`data-update-track ${running && progress?.percent == null ? 'is-indeterminate' : ''}`}
        role="progressbar"
        aria-label="资金数据更新进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress?.percent ?? undefined}
      >
        <span className={`data-update-fill level-${level}`} style={{ width: `${progress?.percent ?? (running ? 12 : 0)}%` }} />
      </div>
      <div className="fund-flow-progress-copy">
        <span>{progress ? formatUpdatePhase(progress.phase) : '正在读取资金数据状态'}</span>
        <strong>{progress?.percent == null ? '—' : `${percent}%`}</strong>
      </div>
      <dl className="fund-flow-facts">
        <div><dt>当前回补日期</dt><dd>{progress?.currentDate ?? '—'}</dd></div>
        <div><dt>累计写入</dt><dd>{progress?.processedRows == null ? '—' : `${progress.processedRows.toLocaleString('zh-CN')} 行`}</dd></div>
        <div><dt>历史覆盖</dt><dd>{progress?.total ? `${progress.completed + progress.failed} / ${progress.total} 日` : '—'}</dd></div>
        <div><dt>每日更新</dt><dd>{updateTime}<small>失败 {retryTime} 重试</small></dd></div>
      </dl>
      {progress?.etaAt && <p>预计完成：{new Date(progress.etaAt).toLocaleString('zh-CN', { hour12: false, dateStyle: 'short', timeStyle: 'short' })}</p>}
    </article>
  );
}

function ConfigGroupHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="config-group-heading">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function ConfigRow({ item, onEdit }: { item: AdminConfigItem; onEdit: (item: AdminConfigItem) => void }) {
  return (
    <div className="config-row">
      <div className={`config-indicator ${item.configured ? 'is-configured' : ''}`}>
        {item.configured ? <CheckCircleOutlined /> : <WarningOutlined />}
      </div>
      <div className="config-copy">
        <div className="config-title">
          <strong>{item.label}</strong>
          <code>{item.key}</code>
        </div>
        <p>{item.description}</p>
      </div>
      <div className="config-value">
        <span>
          {item.inputType === 'boolean' && item.maskedValue
            ? (item.maskedValue === 'true' ? '已开启' : '已关闭')
            : (item.maskedValue ?? '未配置')}
        </span>
        <small className={`scope-tag scope-${item.restartScope}`}>
          {item.restartRequired ? RESTART_SCOPE_LABELS[item.restartScope] : '立即生效'}
        </small>
      </div>
      <button className="secondary-button" disabled={!item.editable} onClick={() => onEdit(item)}>
        {item.editable ? '更新' : '仅手动修改'}
      </button>
    </div>
  );
}

function ConfigDialog({
  item,
  token,
  onClose,
  onSaved,
}: {
  item: AdminConfigItem;
  token: string;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [value, setValue] = useState(() =>
    item.inputType === 'time' || item.inputType === 'boolean'
      ? (item.maskedValue ?? (item.inputType === 'boolean' ? 'true' : ''))
      : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [secretInputReady, setSecretInputReady] = useState(!item.secret);
  // §4.3 实时校验
  const validationError = useMemo(
    () => (value ? validateConfigValue(item.key, value, item.inputType) : null),
    [item.inputType, item.key, value],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) {
      setError(item.secret ? '请输入新的密钥；系统不会读取或回填现有密钥' : '请输入新的配置值');
      return;
    }
    if (item.secret && sanitizeSecretReplacement(value, token).blocked) {
      setValue('');
      setShowSecret(false);
      setError('已阻止浏览器误填管理台访问令牌，请手动输入此配置对应的新密钥');
      return;
    }
    if (validationError) return;
    setSaving(true);
    setError('');
    try {
      const result = await updateAdminConfig(token, { [item.key]: value });
      setValue('');
      await onSaved(result.message);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '配置保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="config-dialog" role="dialog" aria-modal="true" aria-labelledby="config-dialog-title">
        <div className="dialog-header">
          <div>
            <span className="eyebrow">Update configuration</span>
            <h2 id="config-dialog-title">{item.label}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><CloseOutlined /></button>
        </div>
        <form onSubmit={submit} autoComplete="off">
          <label htmlFor="config-value">
            {item.inputType === 'boolean' ? '选择状态' : (item.secret ? '输入新密钥' : '输入新值')}
          </label>
          <div className="input-with-toggle">
            {item.inputType === 'boolean' ? (
              <select
                id="config-value"
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                className={validationError ? 'input-error' : ''}
              >
                <option value="true">开启</option>
                <option value="false">关闭</option>
              </select>
            ) : (
              <input
                id="config-value"
                name={`replacement-${item.key.toLowerCase()}`}
                autoFocus={!item.secret}
                readOnly={item.secret && !secretInputReady}
                type={item.secret && !showSecret ? 'password' : (item.inputType ?? 'text')}
                value={value}
                onChange={(event) => {
                  const next = item.secret
                    ? sanitizeSecretReplacement(event.target.value, token)
                    : { value: event.target.value, blocked: false };
                  if (next.blocked) {
                    setValue('');
                    setShowSecret(false);
                    setError('已清除浏览器误填的管理台访问令牌，请手动输入此配置对应的新密钥');
                    return;
                  }
                  setError('');
                  setValue(next.value);
                }}
                onFocus={(event) => {
                  setSecretInputReady(true);
                  if (item.secret && event.currentTarget.value === token) {
                    event.currentTarget.value = '';
                    setValue('');
                    setShowSecret(false);
                    setError('已清除浏览器误填的管理台访问令牌，请手动输入此配置对应的新密钥');
                  }
                }}
                onPointerDown={() => setSecretInputReady(true)}
                placeholder={item.secret ? '不会显示现有密钥' : item.maskedValue ?? ''}
                autoComplete={item.secret ? 'new-password' : 'off'}
                data-1p-ignore={item.secret ? 'true' : undefined}
                data-lpignore={item.secret ? 'true' : undefined}
                data-form-type={item.secret ? 'other' : undefined}
                className={validationError ? 'input-error' : ''}
              />
            )}
            {item.secret && (
              <button
                type="button"
                className="icon-button secret-toggle"
                aria-label={showSecret ? '隐藏' : '显示'}
                onClick={() => setShowSecret((prev) => !prev)}
              >
                {showSecret ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              </button>
            )}
          </div>
          {validationError && <p className="field-error">{validationError}</p>}
          <p className="field-help">
            {item.description}
            {item.restartRequired && ` 保存后${RESTART_SCOPE_LABELS[item.restartScope]}。`}
          </p>
          {error && <InlineMessage level="critical">{error}</InlineMessage>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={saving || !!validationError || !value.trim() || (item.secret && sanitizeSecretReplacement(value, token).blocked)}>
              {saving ? '正在保存…' : '保存配置'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function LoginScreen({
  enabled,
  token,
  error,
  loading,
  onTokenChange,
  onSubmit,
}: {
  enabled: boolean | null;
  token: string;
  error: string;
  loading: boolean;
  onTokenChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-icon"><LockOutlined /></div>
        <span className="eyebrow">Quant Operations Console</span>
        <h1>量化平台运维管理台</h1>
        <p className="login-description">监测服务、数据库、研究数据和任务状态，并安全维护常用密钥配置。</p>
        {enabled === false ? (
          <InlineMessage level="critical">
            管理 API 当前未启用。请在 server/.env 中设置 ADMIN_API_TOKEN，重启后端后再访问。
          </InlineMessage>
        ) : (
          <form className="login-form" onSubmit={onSubmit} autoComplete="off">
            <label htmlFor="admin-token">管理台访问令牌</label>
            <input
              id="admin-token"
              name="quant-admin-access-token"
              type="password"
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              placeholder="输入 ADMIN_API_TOKEN"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'admin-login-error' : undefined}
              autoFocus
            />
            {error && <div id="admin-login-error"><InlineMessage level="critical">{error}</InlineMessage></div>}
            <button className="primary-button login-button" type="submit" disabled={loading || !token.trim()} aria-busy={loading}>
              {loading ? <ReloadOutlined spin /> : <SafetyCertificateOutlined />}
              {loading ? '正在验证…' : '进入管理台'}
            </button>
          </form>
        )}
        <div className="login-security">
          <SafetyCertificateOutlined />
          <span>令牌仅保存在当前浏览器会话，不会写入 Local Storage。</span>
        </div>
      </section>
    </main>
  );
}

function Sparkline({
  data,
  color,
  width = 100,
  height = 28,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((value, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((value - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  level,
  progress,
  sparkline,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  level: HealthLevel;
  progress?: number;
  sparkline?: ReactNode;
}) {
  return (
    <article className="metric-card">
      <div className="metric-card-head">
        <span className="metric-icon">{icon}</span>
        <StatusBadge level={level} compact />
      </div>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      <span className="metric-detail">{detail}</span>
      {progress != null && (
        <div className="progress-track" aria-label={`${label} 使用率 ${Math.round(Math.min(1, progress) * 100)}%`}>
          <span className={`progress-fill level-${level}`} style={{ width: `${Math.min(1, Math.max(0, progress)) * 100}%` }} />
        </div>
      )}
      {sparkline && <div className="metric-sparkline">{sparkline}</div>}
    </article>
  );
}

function Panel({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <span className="panel-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function IssueCard({ check }: { check: DiagnosticCheck }) {
  const hasDetails = Boolean(check.details?.length);
  const [expanded, setExpanded] = useState(
    check.id === 'data-coverage' && (check.level === 'critical' || check.level === 'warning'),
  );
  return (
    <article
      className={`issue-card level-border-${check.level}`}
      aria-label={`${check.title}：${check.summary}`}
    >
      <span className="issue-icon"><StatusIcon level={check.level} /></span>
      <div>
        <div className="issue-heading">
          <strong>{check.title}</strong>
          <StatusBadge level={check.level} compact />
        </div>
        <p>{check.summary}</p>
        {hasDetails && (
          <>
            <button
              type="button"
              className="issue-detail-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <UpOutlined /> : <DownOutlined />}
              {expanded ? '收起详情' : `查看详情（${check.details!.length}）`}
            </button>
            {expanded && (
              <dl className="issue-details">
                {check.details!.map((detail, index) => (
                  <div className={`issue-detail-row ${detail.level ? `is-${detail.level}` : ''}`} key={`${detail.label}-${index}`}>
                    <dt>{detail.label}</dt>
                    <dd>
                      <strong>{detail.value}</strong>
                      {detail.hint && <span>{detail.hint}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        )}
        {check.resolution && <div className="resolution"><strong>建议：</strong>{check.resolution}</div>}
      </div>
    </article>
  );
}

function TaskSummary({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  return (
    <div className="task-summary">
      <div className="task-title"><strong>{title}</strong><span>{entries.reduce((sum, [, count]) => sum + count, 0)} 项</span></div>
      {entries.length === 0 ? <p>暂无任务记录</p> : (
        <div className="task-tags">
          {entries.map(([status, count]) => <span key={status}><code>{status}</code>{count}</span>)}
        </div>
      )}
    </div>
  );
}

function NavButton({
  active,
  icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={active ? 'nav-button is-active' : 'nav-button'} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <span>{icon}</span>
      {children}
    </button>
  );
}

function StatusBadge({ level, compact = false }: { level: HealthLevel; compact?: boolean }) {
  const labels: Record<HealthLevel, string> = {
    healthy: '正常',
    warning: '警告',
    critical: '严重',
    disabled: '未启用',
  };
  return (
    <span className={`status-badge level-${level} ${compact ? 'is-compact' : ''}`}>
      <StatusIcon level={level} />
      {labels[level]}
    </span>
  );
}

function StatusIcon({ level }: { level: HealthLevel }) {
  if (level === 'healthy') return <CheckCircleOutlined />;
  if (level === 'warning') return <WarningOutlined />;
  if (level === 'critical') return <CloseCircleOutlined />;
  return <ClockCircleOutlined />;
}

function InlineMessage({
  level,
  children,
  onClose,
}: {
  level: 'warning' | 'critical';
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className={`inline-message level-${level}`} role={level === 'critical' ? 'alert' : 'status'}>
      <StatusIcon level={level} />
      <span>{children}</span>
      {onClose && <button type="button" className="icon-button" aria-label="关闭提示" onClick={onClose}><CloseOutlined /></button>}
    </div>
  );
}

function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{description}</p>{action && <div className="empty-state-action">{action}</div>}</div>;
}

function AdminLoadFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <section className="panel admin-load-state" role="alert">
      <EmptyState
        icon={<CloseCircleOutlined />}
        title="无法读取管理台状态"
        description={error}
        action={<button type="button" className="primary-button" onClick={onRetry}><ReloadOutlined />重新连接</button>}
      />
    </section>
  );
}

function SectionLoadFailure({ label }: { label: string }) {
  return (
    <section className="panel admin-load-state" role="status">
      <EmptyState icon={<ReloadOutlined spin />} title={label} description="请稍后刷新，管理台会保留已有的安全会话。" />
    </section>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return <main className="loading-page" aria-busy="true"><ReloadOutlined spin /><span>{label}</span></main>;
}

function DashboardSkeleton() {
  return (
    <div className="skeleton-stack" aria-label="正在加载运行状态" aria-busy="true">
      <div className="skeleton skeleton-banner" />
      <div className="metric-grid">
        {[0, 1, 2, 3].map((item) => <div className="skeleton skeleton-card" key={item} />)}
      </div>
      <div className="skeleton skeleton-panel" />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

export default App;
