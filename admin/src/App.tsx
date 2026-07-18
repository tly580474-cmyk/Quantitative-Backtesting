import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  HddOutlined,
  KeyOutlined,
  LockOutlined,
  LogoutOutlined,
  MenuOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  AdminApiError,
  getAdminConfig,
  getAdminHealth,
  getAdminOverview,
  getAdminStatus,
  getMetricsHistory,
  updateAdminConfig,
  verifyAdminToken,
} from './api';
import type { AdminConfigItem, AdminHealth, AdminOverview, DiagnosticCheck, HealthLevel, MetricSample } from './types';

type Section = 'overview' | 'diagnostics' | 'configuration';

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

/** 前端实时校验，与 server/src/admin/envConfig.ts validateEnvValue 规则一致（见 §4.3） */
function validateConfigValue(key: string, value: string): string | null {
  if (['DB_HOST', 'DB_USER', 'DB_NAME', 'OPENAI_MODEL'].includes(key) && !value.trim()) {
    return `${key} 不能为空`;
  }
  if (key === 'DB_PORT') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return 'DB_PORT 必须是 1 到 65535 的整数';
    }
  }
  if (key === 'AI_STRATEGY_ENABLED' && !['true', 'false'].includes(value)) {
    return 'AI_STRATEGY_ENABLED 只能是 true 或 false';
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

function AdminShell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [section, setSection] = useState<Section>('overview');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [config, setConfig] = useState<AdminConfigItem[]>([]);
  const [metrics, setMetrics] = useState<MetricSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editing, setEditing] = useState<AdminConfigItem | null>(null);
  const [notice, setNotice] = useState('');
  const [configSearch, setConfigSearch] = useState('');
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
      const [nextOverview, nextConfig] = await Promise.all([
        getAdminOverview(token),
        getAdminConfig(token),
      ]);
      setOverview(nextOverview);
      setConfig(nextConfig);
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

  useEffect(() => {
    void refreshOverview();
    const healthTimer = window.setInterval(() => void refreshHealth(true), 15_000);
    const metricsTimer = window.setInterval(() => void refreshMetrics(), 30_000);
    return () => {
      window.clearInterval(healthTimer);
      window.clearInterval(metricsTimer);
    };
  }, [refreshOverview, refreshHealth, refreshMetrics]);

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
          <strong>15 秒 · 健康轮询</strong>
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
          {error && <InlineMessage level="critical">{error}</InlineMessage>}
          {notice && <InlineMessage level="warning" onClose={() => setNotice('')}>{notice}</InlineMessage>}
          {/* §4.2 critical 常驻横幅 */}
          {overview?.overall === 'critical' && (
            <InlineMessage level="critical">
              <AlertOutlined /> 系统当前处于 critical 状态，请立即检查下方诊断项。
            </InlineMessage>
          )}
          {loading && !overview ? (
            <DashboardSkeleton />
          ) : section === 'overview' ? (
            overview && <OverviewSection overview={overview} metrics={metrics} onRefreshMetrics={() => void refreshMetrics()} />
          ) : section === 'diagnostics' ? (
            overview && <DiagnosticsSection checks={overview.checks} />
          ) : (
            <ConfigurationSection
              items={config}
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
    </div>
  );
}

function OverviewSection({ overview, metrics, onRefreshMetrics }: {
  overview: AdminOverview;
  metrics: MetricSample[];
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
  search,
  onSearchChange,
}: {
  items: AdminConfigItem[];
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
        <input
          type="text"
          placeholder="搜索配置项名称、键名或描述…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {search && (
          <button className="icon-button" aria-label="清除搜索" onClick={() => onSearchChange('')}>
            <CloseOutlined />
          </button>
        )}
      </div>
      <InlineMessage level="warning">
        管理台不会返回密钥明文。修改会写入 server/.env，但已创建的数据库连接、AI Provider 和调度器需要重启后端才能完全生效。
      </InlineMessage>
      {categories.map((category) => {
        const categoryItems = items.filter((item) => item.category === category && matchesSearch(item));
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
                    <small className={`scope-tag scope-${item.restartScope}`}>
                      {item.restartRequired ? RESTART_SCOPE_LABELS[item.restartScope] : '立即生效'}
                    </small>
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
  const [showSecret, setShowSecret] = useState(false);
  // §4.3 实时校验
  const validationError = useMemo(
    () => (value ? validateConfigValue(item.key, value) : null),
    [item.key, value],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
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
        <form onSubmit={submit}>
          <label htmlFor="config-value">{item.secret ? '输入新密钥' : '输入新值'}</label>
          <div className="input-with-toggle">
            <input
              id="config-value"
              autoFocus
              type={item.secret && !showSecret ? 'password' : 'text'}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={item.secret ? '不会显示现有密钥' : item.maskedValue ?? ''}
              autoComplete="off"
              className={validationError ? 'input-error' : ''}
            />
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
            <button type="submit" className="primary-button" disabled={saving || (!!validationError) || (!item.secret && !value.trim())}>
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
