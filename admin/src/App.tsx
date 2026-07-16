import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  HddOutlined,
  KeyOutlined,
  LockOutlined,
  LogoutOutlined,
  MenuOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  AdminApiError,
  getAdminConfig,
  getAdminOverview,
  getAdminStatus,
  updateAdminConfig,
  verifyAdminToken,
} from './api';
import type { AdminConfigItem, AdminOverview, DiagnosticCheck, HealthLevel } from './types';

type Section = 'overview' | 'diagnostics' | 'configuration';

const TOKEN_STORAGE_KEY = 'quant-admin-token';
const CATEGORY_LABELS: Record<AdminConfigItem['category'], string> = {
  access: '访问控制',
  database: '数据库',
  ai: '大模型',
  market: '行情数据',
  runtime: '研究运行时',
};

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

function AdminShell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [section, setSection] = useState<Section>('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [config, setConfig] = useState<AdminConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editing, setEditing] = useState<AdminConfigItem | null>(null);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [nextOverview, nextConfig] = await Promise.all([
        getAdminOverview(token),
        getAdminConfig(token),
      ]);
      setOverview(nextOverview);
      setConfig(nextConfig);
      setLastRefresh(new Date());
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : '刷新失败';
      setError(message);
      if (refreshError instanceof AdminApiError && refreshError.status === 401) onLogout();
    } finally {
      if (!silent) setLoading(false);
    }
  }, [onLogout, token]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const navigate = (next: Section) => {
    setSection(next);
    setSidebarOpen(false);
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
          <strong>15 秒</strong>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}

      <main className="admin-main">
        <header className="admin-header">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(true)}>
            <MenuOutlined />
          </button>
          <div>
            <span className="eyebrow">Operations Console</span>
            <h1>{section === 'overview' ? '运行总览' : section === 'diagnostics' ? '问题诊断' : '配置与密钥'}</h1>
          </div>
          <div className="header-actions">
            <div className="refresh-meta">
              <span>上次刷新</span>
              <strong>{lastRefresh ? lastRefresh.toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</strong>
            </div>
            <button className="secondary-button" disabled={loading} onClick={() => void refresh()}>
              <ReloadOutlined spin={loading} />
              <span>刷新</span>
            </button>
            <button className="icon-button" aria-label="退出管理台" title="退出管理台" onClick={onLogout}>
              <LogoutOutlined />
            </button>
          </div>
        </header>

        <div className="admin-content">
          {error && <InlineMessage level="critical">{error}</InlineMessage>}
          {notice && <InlineMessage level="warning" onClose={() => setNotice('')}>{notice}</InlineMessage>}
          {loading && !overview ? (
            <DashboardSkeleton />
          ) : section === 'overview' ? (
            overview && <OverviewSection overview={overview} />
          ) : section === 'diagnostics' ? (
            overview && <DiagnosticsSection checks={overview.checks} />
          ) : (
            <ConfigurationSection items={config} onEdit={setEditing} />
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
            await refresh(true);
          }}
        />
      )}
    </div>
  );
}

function OverviewSection({ overview }: { overview: AdminOverview }) {
  const connectionUsage = overview.database.maxConnections && overview.database.threadsConnected != null
    ? overview.database.threadsConnected / overview.database.maxConnections
    : null;
  const heapUsage = overview.service.memory.heapTotalBytes > 0
    ? overview.service.memory.heapUsedBytes / overview.service.memory.heapTotalBytes
    : 0;
  const issueCount = overview.counts.critical + overview.counts.warning;

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

      <section className="metric-grid" aria-label="核心运行指标">
        <MetricCard
          icon={<CloudServerOutlined />}
          label="后端服务"
          value={formatBytes(overview.service.memory.rssBytes)}
          detail={`RSS 内存 · PID ${overview.service.pid}`}
          level="healthy"
          progress={heapUsage}
        />
        <MetricCard
          icon={<DatabaseOutlined />}
          label="MySQL"
          value={overview.database.latencyMs == null ? '不可用' : `${overview.database.latencyMs}ms`}
          detail={overview.database.version ? `MySQL ${overview.database.version}` : '连接失败'}
          level={overview.database.status}
          progress={connectionUsage ?? undefined}
        />
        <MetricCard
          icon={<HddOutlined />}
          label="数据磁盘"
          value={overview.storage.disk ? `${Math.round(overview.storage.disk.usedPercent * 100)}%` : '未知'}
          detail={overview.storage.disk ? `剩余 ${formatBytes(overview.storage.disk.freeBytes)}` : '无法读取容量'}
          level={overview.storage.disk && overview.storage.disk.usedPercent >= 0.9
            ? 'critical' : overview.storage.disk && overview.storage.disk.usedPercent >= 0.8 ? 'warning' : 'healthy'}
          progress={overview.storage.disk?.usedPercent}
        />
        <MetricCard
          icon={<ClockCircleOutlined />}
          label="DuckDB 会话"
          value={`${overview.duckdb.active} / ${overview.duckdb.limit}`}
          detail={overview.duckdb.queued > 0 ? `${overview.duckdb.queued} 个查询排队` : '当前无等待查询'}
          level={overview.duckdb.queued > 0 ? 'warning' : 'healthy'}
          progress={overview.duckdb.limit > 0 ? overview.duckdb.active / overview.duckdb.limit : 0}
        />
      </section>

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
            className={filter === value ? 'filter-button is-active' : 'filter-button'}
            key={value}
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
  onEdit,
}: {
  items: AdminConfigItem[];
  onEdit: (item: AdminConfigItem) => void;
}) {
  const categories = Object.keys(CATEGORY_LABELS) as AdminConfigItem['category'][];
  return (
    <>
      <InlineMessage level="warning">
        管理台不会返回密钥明文。修改会写入 server/.env，但已创建的数据库连接、AI Provider 和调度器需要重启后端才能完全生效。
      </InlineMessage>
      {categories.map((category) => {
        const categoryItems = items.filter((item) => item.category === category);
        if (categoryItems.length === 0) return null;
        return (
          <Panel
            key={category}
            title={CATEGORY_LABELS[category]}
            subtitle={`${categoryItems.filter((item) => item.configured).length}/${categoryItems.length} 项已配置`}
            icon={category === 'database' ? <DatabaseOutlined /> : category === 'access' ? <LockOutlined /> : <SettingOutlined />}
          >
            <div className="config-list">
              {categoryItems.map((item) => (
                <div className="config-row" key={item.key}>
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
                    <span>{item.maskedValue ?? '未配置'}</span>
                    <small>{item.restartRequired ? '重启后生效' : '立即生效'}</small>
                  </div>
                  <button className="secondary-button" disabled={!item.editable} onClick={() => onEdit(item)}>
                    {item.editable ? '更新' : '仅手动修改'}
                  </button>
                </div>
              ))}
            </div>
          </Panel>
        );
      })}
    </>
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
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
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
        <form onSubmit={submit}>
          <label htmlFor="config-value">{item.secret ? '输入新密钥' : '输入新值'}</label>
          <input
            id="config-value"
            autoFocus
            type={item.secret ? 'password' : 'text'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={item.secret ? '不会显示现有密钥' : item.maskedValue ?? ''}
            autoComplete="off"
          />
          <p className="field-help">{item.description} 保存后需要重启后端。</p>
          {error && <InlineMessage level="critical">{error}</InlineMessage>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={saving || (!item.secret && !value.trim())}>
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
          <form className="login-form" onSubmit={onSubmit}>
            <label htmlFor="admin-token">管理台访问令牌</label>
            <input
              id="admin-token"
              type="password"
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
              autoComplete="current-password"
              placeholder="输入 ADMIN_API_TOKEN"
              autoFocus
            />
            {error && <InlineMessage level="critical">{error}</InlineMessage>}
            <button className="primary-button login-button" type="submit" disabled={loading || !token.trim()}>
              <SafetyCertificateOutlined />
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

function MetricCard({
  icon,
  label,
  value,
  detail,
  level,
  progress,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  level: HealthLevel;
  progress?: number;
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
  return (
    <article className={`issue-card level-border-${check.level}`}>
      <span className="issue-icon"><StatusIcon level={check.level} /></span>
      <div>
        <div className="issue-heading">
          <strong>{check.title}</strong>
          <StatusBadge level={check.level} compact />
        </div>
        <p>{check.summary}</p>
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
    <button className={active ? 'nav-button is-active' : 'nav-button'} onClick={onClick}>
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
      {onClose && <button className="icon-button" aria-label="关闭提示" onClick={onClose}><CloseOutlined /></button>}
    </div>
  );
}

function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{description}</p></div>;
}

function LoadingScreen({ label }: { label: string }) {
  return <main className="loading-page"><ReloadOutlined spin /><span>{label}</span></main>;
}

function DashboardSkeleton() {
  return (
    <div className="skeleton-stack" aria-label="正在加载运行状态">
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
