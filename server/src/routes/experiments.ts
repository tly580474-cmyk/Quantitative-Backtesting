import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  completeExperimentRunRequestSchema,
  confirmExperimentRequestSchema,
  createExperimentRunRequestSchema,
  failExperimentRunRequestSchema,
  openLockedTestRequestSchema,
  validateExperimentRunRequestSchema,
  enqueueExperimentArtifactRequestSchema,
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
import {
  enqueueReportArtifact,
  getExperimentReport,
  getReportArtifactJob,
  openLockedTest,
  processReportArtifactJob,
  validateCompletedExperimentRun,
} from '../experiments/m3Repository.js';
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
    app.post('/api/experiments/versions/:id/locked-test/open', stub);
    app.post('/api/experiments/runs/:id/validate', stub);
    app.get('/api/experiments/runs/:id/report', stub);
    app.post('/api/experiments/runs/:id/report/artifacts', stub);
    app.get('/api/experiments/artifact-jobs/:id', stub);
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
    if ('lockedConflict' in result && result.lockedConflict) {
      return reply.status(409).send(apiError(
        ErrorCodes.LOCKED_TEST_BINDING_MISMATCH,
        '锁定测试打开后不能修改策略参数、回测配置或数据快照',
        result.bindingChecks,
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
    // M3 validation/report generation is deliberately downstream from the
    // authoritative result transition. A report failure must never roll back
    // or rewrite a completed backtest.
    await validateCompletedExperimentRun(req.params.id).catch((error) => {
      req.log.error({ err: error, runId: req.params.id }, 'M3 validation/report generation failed');
    });
    return reply.send((await getExperimentRun(req.params.id)) ?? result.run);
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

  app.post<{ Params: { id: string } }>('/api/experiments/versions/:id/locked-test/open', async (req, reply) => {
    const parsed = openLockedTestRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const result = await openLockedTest(req.params.id, parsed.data.idempotencyKey);
    if (result.type === 'plan_not_found') {
      return reply.status(409).send(apiError(ErrorCodes.VALIDATION_PLAN_NOT_FOUND, '请先完成一次基准回测以冻结样本计划'));
    }
    if (result.type === 'already_opened') {
      return reply.status(409).send(apiError(ErrorCodes.LOCKED_TEST_ALREADY_OPENED, '该实验版本的锁定测试已经打开，不能再次打开或换键重试'));
    }
    return reply.status(result.reused ? 200 : 201).send(result.plan);
  });

  app.post<{ Params: { id: string } }>('/api/experiments/runs/:id/validate', async (req, reply) => {
    const parsed = validateExperimentRunRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const result = await validateCompletedExperimentRun(
      req.params.id,
      parsed.data.perturbations,
      parsed.data.sampleResults,
    );
    if (result.type === 'run_not_found') {
      return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_RUN_NOT_FOUND, '实验运行不存在'));
    }
    if (result.type !== 'evaluated') {
      return reply.status(409).send(apiError(ErrorCodes.INVALID_EXPERIMENT_STATE, '只有已完成且已绑定结果的运行可以校验'));
    }
    return reply.send(result);
  });

  app.get<{ Params: { id: string } }>('/api/experiments/runs/:id/report', async (req, reply) => {
    const report = await getExperimentReport(req.params.id);
    if (!report) return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_REPORT_NOT_FOUND, '实验报告尚未生成'));
    return reply.send(report);
  });

  app.post<{ Params: { id: string } }>('/api/experiments/runs/:id/report/artifacts', async (req, reply) => {
    const parsed = enqueueExperimentArtifactRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const report = await getExperimentReport(req.params.id);
    if (!report) return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_REPORT_NOT_FOUND, '实验报告尚未生成'));
    const queued = await enqueueReportArtifact(report.id, parsed.data.format);
    if (!queued) return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_REPORT_NOT_FOUND, '实验报告不存在'));
    setImmediate(() => {
      void processReportArtifactJob(queued.job.id).catch((error) => {
        app.log.error({ err: error, jobId: queued.job.id }, 'experiment artifact worker failed');
      });
    });
    return reply.status(queued.reused ? 200 : 202).send(queued.job);
  });

  app.get<{ Params: { id: string } }>('/api/experiments/artifact-jobs/:id', async (req, reply) => {
    const job = await getReportArtifactJob(req.params.id);
    if (!job) return reply.status(404).send(apiError(ErrorCodes.EXPERIMENT_ARTIFACT_JOB_NOT_FOUND, '报告制品任务不存在'));
    return reply.send(job);
  });
}
