import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import {
  createSyncJob, getSyncJob, getSyncJobItems, listSyncJobs, getRunningJob,
} from '../marketData/repositories/syncJobRepository.js';
import { executeSyncJob, cancelSyncJob } from '../marketData/jobs/syncExecutor.js';
import { getActiveProvider, getProvider } from '../marketData/providers/providerRegistry.js';
import type { SyncJob } from '../marketData/types.js';

// ─── Zod Schemas ───────────────────────────────────────────────────────

const listJobsQuerySchema = z.object({
  status: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const instrumentSyncBodySchema = z.object({
  market: z.string().optional(),
  providerId: z.string().optional(),
});

const calendarSyncBodySchema = z.object({
  market: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  providerId: z.string().optional(),
});

const historySyncBodySchema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(100),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  providerId: z.string().optional(),
});

const incrementalSyncBodySchema = z.object({
  market: z.string().optional(),
  providerId: z.string().optional(),
});

// ─── Provider type (MarketDataProvider from provider.ts) ─────────────────
type Provider = ReturnType<typeof getActiveProvider>;
type ResolvedProvider = NonNullable<Provider>;

// ─── Helpers ────────────────────────────────────────────────────────────

function resolveProvider(providerId?: string): ResolvedProvider | null {
  return providerId ? getProvider(providerId) : getActiveProvider();
}

function fireAndCatch(job: SyncJob, provider: ResolvedProvider): void {
  executeSyncJob(job, provider).catch((err: unknown) => {
    console.error(
      `Sync job ${job.id} (${job.jobType}) failed:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}

// ─── Route Registration ─────────────────────────────────────────────────

export function registerSyncJobRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.post('/api/sync/instruments', stub);
    app.post('/api/sync/calendars', stub);
    app.post('/api/sync/history', stub);
    app.post('/api/sync/incremental', stub);
    app.get('/api/sync/jobs', stub);
    app.get('/api/sync/jobs/:id', stub);
    app.post('/api/sync/jobs/:id/cancel', stub);
    app.post('/api/sync/jobs/:id/retry', stub);
    return;
  }

  // POST /api/sync/instruments — Sync instrument list from provider
  app.post<{ Body: z.infer<typeof instrumentSyncBodySchema> }>(
    '/api/sync/instruments',
    async (req, reply) => {
      const parsed = instrumentSyncBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
        );
      }

      const { market, providerId } = parsed.data;
      const provider = resolveProvider(providerId);
      if (!provider) {
        return reply.status(400).send(
          apiError(ErrorCodes.PROVIDER_ERROR, '没有可用的数据提供者，请配置 providerId'),
        );
      }

      // Prevent concurrent sync jobs
      const existingJob = await getRunningJob();
      if (existingJob) {
        return reply.status(409).send(
          apiError(ErrorCodes.SYNC_IN_PROGRESS, `已有同步任务正在运行 (${existingJob.id})`),
        );
      }

      const now = new Date().toISOString();
      const job = {
        id: crypto.randomUUID(),
        jobType: 'instruments' as const,
        status: 'pending' as const,
        providerId: provider.id,
        requestSnapshot: { market },
        totalItems: 0,
        completedItems: 0,
        failedItems: 0,
        createdAt: now,
      };
      await createSyncJob(job);

      fireAndCatch(job, provider);
      return reply.status(201).send({ jobId: job.id });
    },
  );

  // POST /api/sync/calendars — Sync trading calendar
  app.post<{ Body: z.infer<typeof calendarSyncBodySchema> }>(
    '/api/sync/calendars',
    async (req, reply) => {
      const parsed = calendarSyncBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
        );
      }

      const { market, startDate, endDate, providerId } = parsed.data;
      const provider = resolveProvider(providerId);
      if (!provider) {
        return reply.status(400).send(
          apiError(ErrorCodes.PROVIDER_ERROR, '没有可用的数据提供者，请配置 providerId'),
        );
      }

      const existingJob = await getRunningJob();
      if (existingJob) {
        return reply.status(409).send(
          apiError(ErrorCodes.SYNC_IN_PROGRESS, `已有同步任务正在运行 (${existingJob.id})`),
        );
      }

      const now = new Date().toISOString();
      const job = {
        id: crypto.randomUUID(),
        jobType: 'calendar' as const,
        status: 'pending' as const,
        providerId: provider.id,
        requestSnapshot: { market, startDate, endDate },
        totalItems: 0,
        completedItems: 0,
        failedItems: 0,
        createdAt: now,
      };
      await createSyncJob(job);

      fireAndCatch(job, provider);
      return reply.status(201).send({ jobId: job.id });
    },
  );

  // POST /api/sync/history — Sync historical daily candles
  app.post<{ Body: z.infer<typeof historySyncBodySchema> }>(
    '/api/sync/history',
    async (req, reply) => {
      const parsed = historySyncBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
        );
      }

      const { symbols, startDate, endDate, providerId } = parsed.data;
      const provider = resolveProvider(providerId);
      if (!provider) {
        return reply.status(400).send(
          apiError(ErrorCodes.PROVIDER_ERROR, '没有可用的数据提供者，请配置 providerId'),
        );
      }

      const existingJob = await getRunningJob();
      if (existingJob) {
        return reply.status(409).send(
          apiError(ErrorCodes.SYNC_IN_PROGRESS, `已有同步任务正在运行 (${existingJob.id})`),
        );
      }

      const now = new Date().toISOString();
      const job = {
        id: crypto.randomUUID(),
        jobType: 'history' as const,
        status: 'pending' as const,
        providerId: provider.id,
        requestSnapshot: { symbols, startDate, endDate },
        totalItems: symbols.length,
        completedItems: 0,
        failedItems: 0,
        createdAt: now,
      };
      await createSyncJob(job);

      fireAndCatch(job, provider);
      return reply.status(201).send({ jobId: job.id });
    },
  );

  // POST /api/sync/incremental — Sync incremental updates
  app.post<{ Body: z.infer<typeof incrementalSyncBodySchema> }>(
    '/api/sync/incremental',
    async (req, reply) => {
      const parsed = incrementalSyncBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
        );
      }

      const { market, providerId } = parsed.data;
      const provider = resolveProvider(providerId);
      if (!provider) {
        return reply.status(400).send(
          apiError(ErrorCodes.PROVIDER_ERROR, '没有可用的数据提供者，请配置 providerId'),
        );
      }

      const existingJob = await getRunningJob();
      if (existingJob) {
        return reply.status(409).send(
          apiError(ErrorCodes.SYNC_IN_PROGRESS, `已有同步任务正在运行 (${existingJob.id})`),
        );
      }

      const now = new Date().toISOString();
      const job = {
        id: crypto.randomUUID(),
        jobType: 'incremental' as const,
        status: 'pending' as const,
        providerId: provider.id,
        requestSnapshot: { market },
        totalItems: 0,
        completedItems: 0,
        failedItems: 0,
        createdAt: now,
      };
      await createSyncJob(job);

      fireAndCatch(job, provider);
      return reply.status(201).send({ jobId: job.id });
    },
  );

  // GET /api/sync/jobs — List sync jobs with pagination
  app.get('/api/sync/jobs', async (req, reply) => {
    const parsed = listJobsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(
        apiError(ErrorCodes.VALIDATION_ERROR, '参数校验失败', parsed.error.issues),
      );
    }

    const { status, offset, limit } = parsed.data;
    const filters: Record<string, string> = {};
    if (status) filters.status = status;

    const result = await listSyncJobs({ ...filters, offset, limit });
    return reply.send({ items: result.data, total: result.total });
  });

  // GET /api/sync/jobs/:id — Single job with items
  app.get<{ Params: { id: string } }>('/api/sync/jobs/:id', async (req, reply) => {
    const job = await getSyncJob(req.params.id);
    if (!job) {
      return reply.status(404).send(
        apiError(ErrorCodes.SYNC_JOB_NOT_FOUND, '同步任务不存在'),
      );
    }
    return reply.send({ ...job, items: await getSyncJobItems(job.id) });
  });

  // POST /api/sync/jobs/:id/cancel — Cancel a running job
  app.post<{ Params: { id: string } }>(
    '/api/sync/jobs/:id/cancel',
    async (req, reply) => {
      const job = await getSyncJob(req.params.id);
      if (!job) {
        return reply.status(404).send(
          apiError(ErrorCodes.SYNC_JOB_NOT_FOUND, '同步任务不存在'),
        );
      }

      if (job.status !== 'running' && job.status !== 'pending') {
        return reply.status(409).send(
          apiError(ErrorCodes.SYNC_IN_PROGRESS, '只能取消运行中或等待中的任务'),
        );
      }

      await cancelSyncJob(req.params.id);
      return reply.send({ ok: true });
    },
  );

  // POST /api/sync/jobs/:id/retry — Retry failed items from a previous job
  app.post<{ Params: { id: string } }>(
    '/api/sync/jobs/:id/retry',
    async (req, reply) => {
      const originalJob = await getSyncJob(req.params.id);
      if (!originalJob) {
        return reply.status(404).send(
          apiError(ErrorCodes.SYNC_JOB_NOT_FOUND, '同步任务不存在'),
        );
      }

      if (originalJob.failedItems === 0) {
        return reply.status(400).send(
          apiError(ErrorCodes.VALIDATION_ERROR, '该任务没有失败项，无需重试'),
        );
      }

      // Only one job can run at a time
      const existingJob = await getRunningJob();
      if (existingJob) {
        return reply.status(409).send(
          apiError(ErrorCodes.SYNC_IN_PROGRESS, `已有同步任务正在运行 (${existingJob.id})`),
        );
      }

      const now = new Date().toISOString();
      const job = {
        id: crypto.randomUUID(),
        jobType: originalJob.jobType,
        status: 'pending' as const,
        providerId: originalJob.providerId,
        requestSnapshot: originalJob.requestSnapshot,
        totalItems: originalJob.failedItems,
        completedItems: 0,
        failedItems: 0,
        createdAt: now,
      };
      await createSyncJob(job);

      const provider = getProvider(originalJob.providerId) ?? getActiveProvider();
      if (provider) {
        fireAndCatch(job, provider);
      }

      return reply.status(201).send({ jobId: job.id });
    },
  );
}
