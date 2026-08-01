import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  createQueuedMultiAssetRun,
  getMultiAssetPlanVersion,
  getMultiAssetRun,
  listMultiAssetPlanVersions,
  listMultiAssetRuns,
} from '../multiAsset/repository.js';
import { freezeSnapshotMultiAssetPlan, processMultiAssetRun } from '../multiAsset/runService.js';
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
      else setImmediate(() => {
        void processMultiAssetRun(result.run.id, options).catch((error) => {
          app.log.error({ err: error, runId: result.run.id }, 'multi-asset worker failed');
        });
      });
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
}
