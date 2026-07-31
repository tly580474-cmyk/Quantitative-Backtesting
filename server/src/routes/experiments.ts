import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  completeExperimentRunRequestSchema,
  confirmExperimentRequestSchema,
  createExperimentRunRequestSchema,
  failExperimentRunRequestSchema,
} from '../experiments/schema.js';
import {
  completeExperimentRun,
  confirmExperimentVersion,
  createExperimentRun,
  finishExperimentRun,
  getExperimentRun,
  getExperimentVersion,
  listExperimentVersions,
  listExperimentRuns,
} from '../experiments/repository.js';
import { apiError, dbUnavailable, ErrorCodes } from '../validation/errors.js';

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.status(400).send(apiError(
    ErrorCodes.VALIDATION_ERROR,
    '实验请求未通过校验',
    issues,
  ));
}

export function registerExperimentRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.post('/api/experiments/versions/confirm', stub);
    app.post('/api/experiments/runs', stub);
    app.get('/api/experiments/versions', stub);
    app.get('/api/experiments/versions/:id', stub);
    app.get('/api/experiments/runs', stub);
    app.get('/api/experiments/runs/:id', stub);
    app.post('/api/experiments/runs/:id/complete', stub);
    app.post('/api/experiments/runs/:id/fail', stub);
    app.post('/api/experiments/runs/:id/cancel', stub);
    return;
  }

  app.post('/api/experiments/versions/confirm', async (req, reply) => {
    const parsed = confirmExperimentRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const { strategy, ...input } = parsed.data;
    const result = await confirmExperimentVersion({
      ...input,
      strategy,
      confirmation: parsed.data.confirmation,
    });
    return reply.status(result.reused ? 200 : 201).send(result);
  });

  app.post('/api/experiments/runs', async (req, reply) => {
    const parsed = createExperimentRunRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const result = await createExperimentRun(parsed.data);
    if (!result) {
      return reply.status(404).send(apiError(
        ErrorCodes.EXPERIMENT_VERSION_NOT_FOUND,
        '实验版本不存在',
      ));
    }
    if (result.conflict) {
      return reply.status(409).send(apiError(
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        '同一幂等键对应了不同的运行输入',
      ));
    }
    return reply.status(result.reused ? 200 : 201).send(result);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/experiments/versions', async (req, reply) => {
    const limit = Number.parseInt(req.query.limit ?? '50', 10);
    return reply.send(await listExperimentVersions(limit));
  });

  app.get<{ Params: { id: string } }>('/api/experiments/versions/:id', async (req, reply) => {
    const version = await getExperimentVersion(req.params.id);
    if (!version) {
      return reply.status(404).send(apiError(
        ErrorCodes.EXPERIMENT_VERSION_NOT_FOUND,
        '实验版本不存在',
      ));
    }
    return reply.send(version);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/experiments/runs', async (req, reply) => {
    const limit = Number.parseInt(req.query.limit ?? '50', 10);
    return reply.send(await listExperimentRuns(limit));
  });

  app.get<{ Params: { id: string } }>('/api/experiments/runs/:id', async (req, reply) => {
    const run = await getExperimentRun(req.params.id);
    if (!run) {
      return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_RUN_NOT_FOUND, '实验运行不存在'));
    }
    return reply.send(run);
  });

  app.post<{ Params: { id: string } }>('/api/experiments/runs/:id/complete', async (req, reply) => {
    const parsed = completeExperimentRunRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const result = await completeExperimentRun(req.params.id, parsed.data);
    if (result.type === 'not_found') {
      return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_RUN_NOT_FOUND, '实验运行不存在'));
    }
    if (result.type === 'result_not_found') {
      return reply.status(409).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '回测结果尚未持久化'));
    }
    if (result.type === 'hash_mismatch') {
      return reply.status(409).send(apiError(
        ErrorCodes.RESULT_HASH_MISMATCH,
        '客户端结果摘要与服务端权威结果不一致',
        { authoritativeHash: result.authoritativeHash },
      ));
    }
    if (result.type === 'result_binding_mismatch') {
      return reply.status(409).send(apiError(
        ErrorCodes.RESULT_BINDING_MISMATCH,
        '回测结果与冻结实验规格或执行计划不一致',
        result.bindingChecks,
      ));
    }
    if (result.type === 'invalid_state') {
      return reply.status(409).send(apiError(
        ErrorCodes.INVALID_EXPERIMENT_STATE,
        `当前运行状态 ${result.run.status} 不允许完成`,
      ));
    }
    return reply.send(result.run);
  });

  app.post<{ Params: { id: string } }>('/api/experiments/runs/:id/fail', async (req, reply) => {
    const parsed = failExperimentRunRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const run = await finishExperimentRun(req.params.id, 'failed', {
      code: parsed.data.errorCode,
      message: parsed.data.message,
    });
    if (!run) {
      return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_RUN_NOT_FOUND, '实验运行不存在'));
    }
    return reply.send(run);
  });

  app.post<{ Params: { id: string } }>('/api/experiments/runs/:id/cancel', async (req, reply) => {
    const run = await finishExperimentRun(req.params.id, 'cancelled');
    if (!run) {
      return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_RUN_NOT_FOUND, '实验运行不存在'));
    }
    return reply.send(run);
  });
}
