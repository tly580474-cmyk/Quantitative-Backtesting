import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import {
  createQueuedMultiAssetRun,
  getMultiAssetRunArtifact,
  getMultiAssetPlanVersion,
  getMultiAssetRun,
  listMultiAssetPlanVersions,
  listMultiAssetRuns,
  listMultiAssetRunArtifacts,
  listMultiAssetRunEvents,
  manuallyRetryMultiAssetRun,
  requestMultiAssetRunCancellation,
} from '../multiAsset/repository.js';
import { freezeSnapshotMultiAssetPlan } from '../multiAsset/runService.js';
import { snapshotMultiAssetConfigSchema } from '../multiAsset/snapshotInput.js';
import { apiError, dbUnavailable, ErrorCodes } from '../validation/errors.js';

const createPlanSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  config: snapshotMultiAssetConfigSchema,
});

const createRunSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(8).max(128),
  initialCash: z.number().finite().min(10_000).max(10_000_000_000).default(1_000_000),
});

const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  planVersionId: z.string().uuid().optional(),
});

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.status(400).send(apiError(ErrorCodes.VALIDATION_ERROR, '多资产请求未通过校验', issues));
}

export function registerMultiAssetRoutes(
  app: FastifyInstance,
  dbOnline: boolean,
  options: { snapshotRoot: string; pythonExecutable?: string },
  enqueueRun?: (runId: string) => boolean,
): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.post('/api/multi-asset/plans', stub);
    app.get('/api/multi-asset/plans', stub);
    app.get('/api/multi-asset/plans/:id', stub);
    app.post('/api/multi-asset/plans/:id/runs', stub);
    app.get('/api/multi-asset/runs', stub);
    app.get('/api/multi-asset/runs/:id', stub);
    app.post('/api/multi-asset/runs/:id/cancel', stub);
    app.post('/api/multi-asset/runs/:id/retry', stub);
    app.get('/api/multi-asset/runs/:id/events', stub);
    app.get('/api/multi-asset/runs/:id/events/stream', stub);
    app.get('/api/multi-asset/runs/:id/artifacts', stub);
    app.get('/api/multi-asset/artifacts/:id/download', stub);
    return;
  }

  app.post('/api/multi-asset/plans', async (request, reply) => {
    const parsed = createPlanSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    try {
      const result = await freezeSnapshotMultiAssetPlan({
        name: parsed.data.name,
        snapshotRoot: options.snapshotRoot,
        config: parsed.data.config,
      });
      return reply.status(result.reused ? 200 : 201).send(result);
    } catch (error) {
      return validationError(reply, error instanceof Error ? error.message : String(error));
    }
  });

  app.get('/api/multi-asset/plans', async (request, reply) => {
    const parsed = listQuerySchema.pick({ limit: true }).safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    return reply.send(await listMultiAssetPlanVersions(parsed.data.limit));
  });

  app.get<{ Params: { id: string } }>('/api/multi-asset/plans/:id', async (request, reply) => {
    const plan = await getMultiAssetPlanVersion(request.params.id);
    if (!plan) return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_PLAN_NOT_FOUND, '多资产计划不存在'));
    return reply.send(plan);
  });

  app.post<{ Params: { id: string } }>('/api/multi-asset/plans/:id/runs', async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const result = await createQueuedMultiAssetRun({ planVersionId: request.params.id, ...parsed.data });
    if (result.type === 'plan_not_found') {
      return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_PLAN_NOT_FOUND, '多资产计划不存在'));
    }
    if (result.type === 'conflict') {
      return reply.status(409).send(apiError(
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        '幂等键已绑定到不同的多资产运行输入',
        { runId: result.run.id },
      ));
    }
    if (!result.reused) {
      if (enqueueRun) enqueueRun(result.run.id);
    }
    return reply.status(result.reused ? 200 : 202).send(result);
  });

  app.get('/api/multi-asset/runs', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    return reply.send(await listMultiAssetRuns(parsed.data.planVersionId, parsed.data.limit));
  });

  app.get<{ Params: { id: string } }>('/api/multi-asset/runs/:id', async (request, reply) => {
    const run = await getMultiAssetRun(request.params.id);
    if (!run) return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_RUN_NOT_FOUND, '多资产运行不存在'));
    return reply.send(run);
  });

  app.post<{ Params: { id: string } }>('/api/multi-asset/runs/:id/cancel', async (request, reply) => {
    const run = await requestMultiAssetRunCancellation(request.params.id);
    if (!run) return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_RUN_NOT_FOUND, '多资产运行不存在'));
    return reply.status(run.status === 'cancelled' ? 200 : 202).send(run);
  });

  app.post<{ Params: { id: string } }>('/api/multi-asset/runs/:id/retry', async (request, reply) => {
    const before = await getMultiAssetRun(request.params.id);
    if (!before) return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_RUN_NOT_FOUND, '多资产运行不存在'));
    if (!['failed', 'dead_letter', 'cancelled'].includes(before.status)) {
      return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR, '当前状态不允许重试'));
    }
    const run = await manuallyRetryMultiAssetRun(request.params.id);
    if (run && enqueueRun) enqueueRun(run.id);
    return reply.status(202).send(run);
  });

  app.get<{ Params: { id: string } }>('/api/multi-asset/runs/:id/events', async (request, reply) => {
    const parsed = z.strictObject({
      afterId: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    }).safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    if (!await getMultiAssetRun(request.params.id)) {
      return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_RUN_NOT_FOUND, '多资产运行不存在'));
    }
    return reply.send(await listMultiAssetRunEvents(request.params.id, parsed.data.afterId, parsed.data.limit));
  });

  app.get<{ Params: { id: string } }>('/api/multi-asset/runs/:id/events/stream', async (request, reply) => {
    if (!await getMultiAssetRun(request.params.id)) {
      return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_RUN_NOT_FOUND, '多资产运行不存在'));
    }
    const parsed = z.strictObject({ afterId: z.coerce.number().int().min(0).default(0) }).safeParse(request.query);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    let afterId = parsed.data.afterId;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const flush = async () => {
      const events = await listMultiAssetRunEvents(request.params.id, afterId, 200);
      for (const event of events) {
        afterId = Number(event.id);
        reply.raw.write(`id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    await flush();
    const interval = setInterval(() => void flush().catch(() => reply.raw.end()), 1_000);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    request.raw.once('close', () => { clearInterval(interval); clearInterval(heartbeat); });
  });

  app.get<{ Params: { id: string } }>('/api/multi-asset/runs/:id/artifacts', async (request, reply) => {
    if (!await getMultiAssetRun(request.params.id)) {
      return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_RUN_NOT_FOUND, '多资产运行不存在'));
    }
    return reply.send(await listMultiAssetRunArtifacts(request.params.id));
  });

  app.get<{ Params: { id: string } }>('/api/multi-asset/artifacts/:id/download', async (request, reply) => {
    const artifact = await getMultiAssetRunArtifact(request.params.id);
    if (!artifact) return reply.status(404).send(apiError(ErrorCodes.MULTI_ASSET_RUN_NOT_FOUND, '运行制品不存在'));
    reply.header('Content-Type', artifact.mediaType);
    reply.header('Content-Disposition', `attachment; filename="${artifact.kind}.json"`);
    reply.header('X-Content-SHA256', artifact.contentHash);
    return reply.send(createReadStream(artifact.storageUri));
  });
}
