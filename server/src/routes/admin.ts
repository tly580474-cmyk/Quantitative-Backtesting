import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import type { EnvConfig } from '../config.js';
import { collectAdminOverview } from '../admin/diagnostics.js';
import { listAdminConfig, updateEnvFile } from '../admin/envConfig.js';

interface AdminRouteOptions {
  pool: Pool;
  dbOnline: boolean;
  config: EnvConfig;
  envFilePath: string | URL;
}

const updateConfigSchema = z.object({
  updates: z.record(z.string(), z.string()).refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 10,
    '每次必须更新 1 到 10 个配置项',
  ),
});

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
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
    const provided = parseBearerToken(request.headers.authorization);
    if (!provided || !safeEqual(provided, expected)) {
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: '管理台访问令牌无效',
      });
    }
  };

  app.post('/api/admin/auth/verify', { preHandler: authorize }, async () => ({
    authenticated: true,
  }));

  app.get('/api/admin/overview', { preHandler: authorize }, async (_request, reply) => {
    try {
      return reply.send(await collectAdminOverview(options));
    } catch (error) {
      app.log.error({ err: error }, 'Admin overview collection failed');
      return reply.status(503).send({
        error: 'DIAGNOSTICS_FAILED',
        message: error instanceof Error ? error.message : '系统诊断失败',
      });
    }
  });

  app.get('/api/admin/config', { preHandler: authorize }, async () => ({
    items: listAdminConfig({ ...options.config, ...process.env }),
  }));

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
        const updatedKeys = await updateEnvFile(options.envFilePath, parsed.data.updates);
        request.log.warn({ updatedKeys }, 'Admin configuration updated; restart required');
        return reply.send({
          updatedKeys,
          restartRequired: true,
          message: '配置已写入 server/.env，重启后端后完全生效',
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

function parseBearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
