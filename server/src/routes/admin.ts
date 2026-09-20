import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import type { EnvConfig } from '../config.js';
import { collectAdminOverview, collectAdminHealth } from '../admin/diagnostics.js';
import { ADMIN_CONFIG_DEFINITIONS, listAdminConfig, updateEnvFile } from '../admin/envConfig.js';
import { checkConnection } from '../db/connection.js';
import { initDb } from '../db/index.js';
import { createAsyncCache } from '../admin/asyncCache.js';
import { createAuthLimits } from '../admin/authLimits.js';
import { createOverviewCache } from '../admin/overviewCache.js';
import { metricsHistory } from '../admin/metricsHistory.js';
import { synchronizeScheduleConfig } from '../admin/scheduleConfig.js';
import { collectDataUpdateProgress } from '../admin/dataUpdateProgress.js';
import {
  getDatabaseBackupExportStatus,
  resolveDatabaseBackupDownload,
  startDatabaseBackupExport,
} from '../admin/databaseBackupExport.js';
import { publicAccessControl, type PublicAccessStatus } from '../admin/publicAccess.js';
import { spawn } from 'node:child_process';
import type { AgentOrchestrator } from '../services/agent/agentOrchestrator.js';
import { AgentRepository } from '../services/agent/agentRepository.js';
import { sanitizePublicContent } from '../services/agent/eventProtocol.js';

export interface AdminRouteOptions {
  pool: Pool;
  dbOnline: boolean;
  config: EnvConfig;
  envFilePath: string | URL;
  restart?: {
    available: boolean;
    request: () => void;
  };
  publicAccess?: {
    status: () => Promise<PublicAccessStatus>;
    setEnabled: (enabled: boolean) => Promise<PublicAccessStatus>;
  };
  agent?: { enabled: boolean; orchestrator: AgentOrchestrator | null };
}

const updateConfigSchema = z.object({
  updates: z.record(z.string(), z.string()).refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 10,
    '每次必须更新 1 到 10 个配置项',
  ),
});

const publicAccessSchema = z.object({ enabled: z.boolean() });

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  const overviewCacheTtl = Number.parseInt(options.config.ADMIN_OVERVIEW_CACHE_TTL_MS, 10);
  const overviewCache = createOverviewCache(Number.isFinite(overviewCacheTtl) ? overviewCacheTtl : 10_000);
  const publicAccess = options.publicAccess ?? publicAccessControl;
  const authLimits = createAuthLimits();
  const databaseCache = createAsyncCache<boolean>(5_000);
  const databaseOnline = () => databaseCache(async () => {
    const online = (await checkConnection(options.pool)).ok;
    if (online) initDb(options.pool);
    return online;
  });
  const progressCaches = [false, true].map(() => createAsyncCache<Awaited<ReturnType<typeof collectDataUpdateProgress>>>(
    value => value.items.some(item => item.status === 'running' || item.status === 'pending') ? 10_000 : 60_000,
  ));
  const versionCache = createAsyncCache<[string | null, string | null, string | null]>(60_000);
  const downloadTickets = new Map<string, { id: string; expiresAt: number }>();
  const rateLimit = (request: FastifyRequest, reply: FastifyReply, recordFailure = false) => {
    const retryAfter = authLimits(request.raw.socket.remoteAddress ?? request.ip, recordFailure);
    if (!retryAfter) return false;
    reply.header('Retry-After', String(retryAfter)).status(429).send({ error: 'RATE_LIMITED', message: '验证失败次数过多，请稍后重试' });
    return true;
  };

  app.get('/api/admin/auth/status', async () => ({
    enabled: options.config.ADMIN_API_TOKEN.trim().length > 0,
  }));

  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const expected = options.config.ADMIN_API_TOKEN.trim();
    if (!expected) {
      return reply.status(503).send({
        error: 'ADMIN_DISABLED',
        message: '管理 API 未启用，请先配置 ADMIN_API_TOKEN 并重启服务',
      });
    }
    reply.header('Cache-Control', 'no-store');
    if (rateLimit(request, reply)) return reply;
    const provided = parseBearerToken(request.headers.authorization);
    if (!provided || !safeEqual(provided, expected)) {
      if (rateLimit(request, reply, true)) return reply;
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: '管理台访问令牌无效',
      });
    }
  };

  app.post('/api/admin/auth/verify', { preHandler: authorize }, async () => ({
    authenticated: true,
  }));

  app.get('/api/admin/health', { preHandler: authorize }, async (_request, reply) => {
    try {
      return reply.send(await collectAdminHealth({ ...options, dbOnline: await databaseOnline() }));
    } catch (error) {
      app.log.error({ err: error }, 'Admin health collection failed');
      return reply.status(503).send({
        error: 'HEALTH_CHECK_FAILED',
        message: error instanceof Error ? error.message : '健康检查失败',
      });
    }
  });

  app.get('/api/admin/overview', { preHandler: authorize }, async (_request, reply) => {
    const dbOnline = await databaseOnline();
    // §1 TTL 缓存：命中时直接返回，失效时重算；重算失败时降级返回陈旧帧
    const cached = overviewCache.get(dbOnline);
    if (cached) return reply.send(cached);
    try {
      const overview = await collectAdminOverview({ ...options, dbOnline });
      overviewCache.set(dbOnline, overview);
      return reply.send(overview);
    } catch (error) {
      const stale = overviewCache.peek(dbOnline);
      if (stale) return reply.send(stale);
      app.log.error({ err: error }, 'Admin overview collection failed');
      return reply.status(503).send({
        error: 'DIAGNOSTICS_FAILED',
        message: error instanceof Error ? error.message : '系统诊断失败',
      });
    }
  });

  app.get('/api/admin/metrics/history', { preHandler: authorize }, async (request, reply) => {
    const since = (request.query as { since?: string })?.since;
    return reply.send({ samples: metricsHistory.list(since) });
  });

  app.get('/api/admin/data-update-progress', { preHandler: authorize }, async () => {
    const dbOnline = await databaseOnline();
    return progressCaches[Number(dbOnline)](() => collectDataUpdateProgress(dbOnline, undefined, undefined, {
      pool: dbOnline ? options.pool : null,
      minuteRoot: options.config.MINUTE_DATA_ROOT,
    }));
  });

  app.get('/api/admin/database-backup', { preHandler: authorize }, async () => (
    getDatabaseBackupExportStatus(options.config)
  ));

  app.post('/api/admin/database-backup', { preHandler: authorize }, async (_request, reply) => {
    if (!await databaseOnline()) {
      return reply.status(503).send({ error: 'DATABASE_UNAVAILABLE', message: '数据库未连接，无法导出备份' });
    }
    try {
      const status = await startDatabaseBackupExport(options.config);
      return reply.status(202).send(status);
    } catch (error) {
      return reply.status(409).send({
        error: 'BACKUP_EXPORT_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const sendDownload = async (id: string, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const download = await resolveDatabaseBackupDownload(options.config, id);
      reply.header('Content-Type', 'application/sql; charset=utf-8');
      reply.header('Content-Length', String(download.bytes));
      reply.header('Content-Disposition', `attachment; filename="${download.fileName}"`);
      reply.header('X-Backup-SHA256', download.sha256);
      return reply.send(createReadStream(download.path));
    } catch (error) {
      return reply.status(404).send({ error: 'BACKUP_NOT_FOUND', message: error instanceof Error ? error.message : '数据库备份不可用' });
    }
  };
  app.get<{ Params: { id: string } }>('/api/admin/database-backup/:id/download', { preHandler: authorize },
    async (request, reply) => sendDownload(request.params.id, reply));

  // Native browser downloads use an expiring, single-use capability, never the admin token.
  app.post<{ Params: { id: string } }>('/api/admin/database-backup/:id/download-ticket', { preHandler: authorize }, async (request, reply) => {
    try { await resolveDatabaseBackupDownload(options.config, request.params.id); }
    catch { return reply.status(404).send({ error: 'BACKUP_NOT_FOUND', message: '数据库备份不可用，请刷新状态' }); }
    for (const [ticket, value] of downloadTickets) if (value.expiresAt <= Date.now()) downloadTickets.delete(ticket);
    if (downloadTickets.size >= 100) return reply.status(429).send({ message: '下载请求过多，请稍后重试' });
    const ticket = randomBytes(32).toString('hex');
    downloadTickets.set(ticket, { id: request.params.id, expiresAt: Date.now() + 60_000 });
    return { ticket };
  });
  app.register(async downloadApp => {
    downloadApp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    downloadApp.post<{ Params: { id: string }; Body: { ticket?: string } }>('/api/admin/database-backup/:id/download', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (rateLimit(request, reply)) return reply;
      const ticket = request.body?.ticket;
      const grant = typeof ticket === 'string' ? downloadTickets.get(ticket) : undefined;
      if (!grant || grant.id !== request.params.id || grant.expiresAt <= Date.now()) {
        if (rateLimit(request, reply, true)) return reply;
        return reply.status(401).send({ message: '下载授权已过期，请重新点击下载' });
      }
      downloadTickets.delete(ticket!);
      return sendDownload(request.params.id, reply);
    });
  });

  app.get('/api/admin/config', { preHandler: authorize }, async () => ({
    items: listAdminConfig({ ...options.config, ...process.env }),
  }));

  app.get('/api/admin/restart/status', { preHandler: authorize }, async () => ({
    available: options.restart?.available === true,
    reason: options.restart?.available
      ? null
      : '当前后端不是由项目监督进程启动，请通过项目启动脚本重新启动后再使用快捷重启。',
  }));

  app.get('/api/admin/public-access', { preHandler: authorize }, async (_request, reply) => {
    try {
      return reply.send(await publicAccess.status());
    } catch (error) {
      return reply.status(503).send({
        error: 'PUBLIC_ACCESS_STATUS_FAILED',
        message: error instanceof Error ? error.message : '无法读取公网访问状态',
      });
    }
  });

  app.get('/api/admin/agent', { preHandler: authorize }, async (_request, reply) => {
    const enabled = options.agent?.enabled === true;
    const orchestrator = options.agent?.orchestrator ?? null;
    const repo = new AgentRepository(options.pool);
    const dbOnline = await databaseOnline();
    const [metrics, recentRuns, pendingApprovals, [codexVersion, piVersion, claudeVersion]] = await Promise.all([
      dbOnline ? repo.getMetrics() : Promise.resolve(null),
      dbOnline ? repo.listRuns(50) : Promise.resolve([]),
      dbOnline ? repo.listPendingApprovals() : Promise.resolve([]),
      versionCache(() => Promise.all([
        readCommandVersion(options.config.AGENT_CODEX_PATH),
        options.config.AGENT_PI_ENABLED === 'true' ? readCommandVersion(options.config.AGENT_PI_PATH) : Promise.resolve(null),
        readCommandVersion(options.config.AGENT_CLAUDE_PATH),
      ])),
    ]);
    let piAuthFileReadable = false;
    if (options.config.AGENT_PI_AGENT_DIRECTORY) {
      try { accessSync(join(options.config.AGENT_PI_AGENT_DIRECTORY, 'auth.json'), constants.R_OK); piAuthFileReadable = true; } catch { /* Readiness only; never read or expose credential contents. */ }
    }
    const latestPiRun = recentRuns.find(run => run.provider === 'pi');
    const failures = recentRuns.filter(run => run.status === 'failed').slice(0, 10).map(run => ({
      runId: run.id, provider: run.provider, errorCode: run.errorCode ?? 'UNKNOWN',
      category: classifyAgentFailure(run.errorCode, run.errorMessage),
      message: sanitizePublicContent(run.errorMessage, '未提供错误信息').slice(0, 240),
      finishedAt: run.finishedAt,
    }));
    return reply.send({
      enabled,
      defaultProvider: orchestrator?.getDefaultProvider() ?? options.config.AGENT_PROVIDER,
      runtime: orchestrator?.getRuntimeStats() ?? { active: 0, capacity: Number(options.config.AGENT_MAX_CONCURRENT) || 1 },
      providers: orchestrator?.getProviderHealth() ?? [],
      claude: {
        enabled, version: claudeVersion,
        workingDirectoryConfigured: Boolean(options.config.AGENT_CLAUDE_WORKING_DIRECTORY),
        gitBashConfigured: Boolean(options.config.AGENT_CLAUDE_GIT_BASH_PATH),
      },
      pi: {
        enabled: options.config.AGENT_PI_ENABLED === 'true', version: piVersion,
        model: options.config.AGENT_PI_MODEL || null, modelProvider: options.config.AGENT_PI_MODEL_PROVIDER || null,
        configurationDirectoryConfigured: Boolean(options.config.AGENT_PI_AGENT_DIRECTORY), authFileReadable: piAuthFileReadable,
        latestRun: latestPiRun ? { id: latestPiRun.id, status: latestPiRun.status, finishedAt: latestPiRun.finishedAt } : null,
      },
      codex: {
        enabled: options.config.AGENT_CODEX_ENABLED === 'true', version: codexVersion,
        model: options.config.AGENT_CODEX_MODEL || null,
        modelProvider: options.config.AGENT_CODEX_MODEL_PROVIDER || 'openai',
        baseUrlConfigured: Boolean(options.config.AGENT_CODEX_BASE_URL),
        apiKeyConfigured: Boolean(options.config.AGENT_CODEX_API_KEY),
        isolatedHome: Boolean(options.config.AGENT_CODEX_HOME),
        approvalsEnabled: options.config.AGENT_CODEX_APPROVALS_ENABLED === 'true',
        toolsEnabled: options.config.AGENT_CODEX_TOOLS_ENABLED === 'true',
        sandboxMode: options.config.AGENT_CODEX_SANDBOX_MODE,
        windowsSandbox: options.config.AGENT_CODEX_WINDOWS_SANDBOX,
        networkEnabled: options.config.AGENT_CODEX_NETWORK_ENABLED === 'true',
        marketDataCliConfigured: Boolean(options.config.AGENT_CODEX_MARKET_DATA_CLI),
        externalDataSkillEnabled: options.config.AGENT_CODEX_EXTERNAL_DATA_SKILL_ENABLED === 'true',
        isolatedPythonConfigured: Boolean(options.config.AGENT_CODEX_PYTHON_PATH),
      },
      persistence: metrics,
      pendingApprovals: pendingApprovals.length,
      recentFailures: failures,
      observedAt: new Date().toISOString(),
    });
  });

  app.put('/api/admin/public-access', { preHandler: authorize }, async (request, reply) => {
    const parsed = publicAccessSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_PUBLIC_ACCESS_SETTING', message: '公网访问配置无效' });
    }
    try {
      const status = await publicAccess.setEnabled(parsed.data.enabled);
      request.log.warn({ enabled: parsed.data.enabled }, 'Admin changed public access');
      return reply.send(status);
    } catch (error) {
      return reply.status(503).send({
        error: 'PUBLIC_ACCESS_UPDATE_FAILED',
        message: error instanceof Error ? error.message : '公网访问配置更新失败',
      });
    }
  });

  app.post('/api/admin/restart', { preHandler: authorize }, async (request, reply) => {
    if (!options.restart?.available) {
      return reply.status(409).send({
        error: 'RESTART_UNAVAILABLE',
        message: '当前运行方式不支持安全重启，请先使用项目启动脚本启动后端。',
      });
    }
    const requestedAt = new Date().toISOString();
    request.log.warn({ requestedAt }, 'Admin requested backend restart');
    const timer = setTimeout(() => options.restart?.request(), 250);
    timer.unref?.();
    return reply.status(202).send({ accepted: true, requestedAt });
  });

  app.put<{ Body: z.infer<typeof updateConfigSchema> }>(
    '/api/admin/config',
    { preHandler: authorize },
    async (request, reply) => {
      const parsed = updateConfigSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'INVALID_CONFIG',
          message: '配置更新参数无效',
          details: parsed.error.issues,
        });
      }
      try {
        const adminToken = options.config.ADMIN_API_TOKEN.trim();
        for (const [key, value] of Object.entries(parsed.data.updates)) {
          if (adminToken && ADMIN_CONFIG_DEFINITIONS.some(item => item.key === key && item.secret) && value.includes(adminToken)) {
            throw new Error('已阻止将管理台访问令牌写入业务密钥');
          }
        }
        const updatedKeys = await updateEnvFile(options.envFilePath, parsed.data.updates);
        const scheduleSync = await synchronizeScheduleConfig(updatedKeys);
        const restartRequired = updatedKeys.some(key =>
          ADMIN_CONFIG_DEFINITIONS.find(item => item.key === key)?.restartRequired !== false);
        request.log.warn({ updatedKeys, scheduleSync }, 'Admin configuration updated');
        overviewCache.invalidate();
        const scheduleMessage = scheduleSync.updatedTasks.length > 0
          ? `；已更新计划任务：${scheduleSync.updatedTasks.join('、')}`
          : '';
        const warningMessage = scheduleSync.warnings.length > 0
          ? `；${scheduleSync.warnings.join('；')}`
          : '';
        return reply.send({
          updatedKeys,
          restartRequired,
          message: `${restartRequired ? '配置已写入 server/.env，重启后端后完全生效' : '配置已写入 server/.env'}${scheduleMessage}${warningMessage}`,
        });
      } catch (error) {
        return reply.status(400).send({
          error: 'CONFIG_UPDATE_FAILED',
          message: error instanceof Error ? error.message : '配置更新失败',
        });
      }
    },
  );
}

function classifyAgentFailure(code: string | null, message: string | null): string {
  const value = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  if (/auth|401|403|api.?key/.test(value)) return 'auth';
  if (/timeout|timed out/.test(value)) return 'timeout';
  if (/protocol|json-rpc|schema/.test(value)) return 'protocol';
  if (/model|404/.test(value)) return 'model';
  if (/cancel|interrupt/.test(value)) return 'canceled';
  if (/spawn|app_server_exit|startup/.test(value)) return 'runtime';
  return 'execution';
}

async function readCommandVersion(commandPath: string): Promise<string | null> {
  if (!commandPath.trim()) return null;
  return new Promise(resolveVersion => {
    const executable = process.platform === 'win32' && commandPath === 'codex' ? 'codex.cmd' : commandPath;
    const isCmd = process.platform === 'win32' && /\.cmd$/i.test(executable);
    const child = spawn(isCmd ? process.env.ComSpec ?? 'cmd.exe' : executable,
      isCmd ? ['/d', '/s', '/c', executable, '--version'] : ['--version'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolveVersion(null); }, 3_000);
    child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(0, 200); });
    child.once('error', () => { clearTimeout(timer); resolveVersion(null); });
    child.once('close', code => { clearTimeout(timer); resolveVersion(code === 0 ? output.trim().slice(0, 120) || null : null); });
  });
}

function parseBearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
