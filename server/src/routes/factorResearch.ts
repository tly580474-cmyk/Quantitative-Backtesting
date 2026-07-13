import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import { auditFactorCorrelations, auditFactorDecay, runFactorResearch } from '../factorResearch/engine/factorRunner.js';
import { runCompositeFactorResearch } from '../factorResearch/engine/compositeRunner.js';
import {
  cancelFactorRun,
  getFactorRunDailySeries,
  getFactorRunById,
  getFactorRunReport,
  listFactorCatalog,
  listRecentFactorRuns,
  persistCompletedCompositeFactorRun,
  persistCompletedFactorRun,
  persistFailedFactorRun,
  syncBuiltinFactorCatalog,
} from '../factorResearch/repositories/factorRepository.js';
import {
  assertResearchSnapshotFresh,
  getResearchSnapshotFreshness,
} from '../research/snapshotFreshness.js';
import { interpretFactorReport } from '../factorResearch/reportInterpreter.js';
import {
  candidateToFactorDefinition,
  archiveMiningTask,
  createFactorCandidate,
  createMiningTask,
  createMiningSchedule,
  deleteMiningTask,
  getFactorCandidate,
  getMiningTask,
  listFactorCandidates,
  listMiningTasks,
  listMiningSchedules,
  publishApprovedCandidate,
  transitionFactorCandidate,
  updateMiningSchedule,
} from '../factorResearch/candidates/candidateRepository.js';
import type { FactorAstNode } from '../factorResearch/definitions/schema.js';
import { factorAstRequiresMaterialization } from '../factorResearch/definitions/factorAst.js';
import { listBuiltinFactors } from '../factorResearch/definitions/validator.js';
import { readCurrentSnapshot } from '../research/snapshotManifest.js';
import { cancelMiningWorker, startMiningWorker } from '../factorResearch/mining/miningWorker.js';
import {
  assertLockedTestCoverage,
  assertLockedTestLineage,
} from '../factorResearch/candidates/lockedTestValidation.js';

interface FactorResearchRouteConfig {
  snapshotRoot: string;
  artifactRoot: string;
  pool: Pool;
  miningWorker: {
    pythonExecutable: string;
    minerRoot: string;
    timeoutMs: number;
    maxMemoryMb: number;
  };
  ai: {
    enabled: boolean;
    configured: boolean;
    apiKey: string;
    baseURL: string;
    model: string;
    timeoutMs: number;
  };
}

const factorRunBodySchema = z.object({
  factorId: z.string().trim().min(1).max(64),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horizonDays: z.number().int().min(1).max(60).default(5),
  layers: z.number().int().min(2).max(20).default(5),
  markets: z.array(z.string().trim().min(1).max(16)).max(8).optional(),
  symbols: z.array(z.string().trim().min(1).max(20)).max(500).optional(),
  minDailyAmount: z.number().min(0).optional(),
});

const compositeRunBodySchema = z.object({
  factorIds: z.array(z.string().trim().min(1).max(64)).min(2).max(12),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validationStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  horizonDays: z.number().int().min(1).max(60).default(5),
  layers: z.number().int().min(2).max(20).default(5),
  weighting: z.enum(['equal', 'ic', 'rankIc', 'manual']).default('equal'),
  manualWeights: z.record(z.string(), z.number()).optional(),
  markets: z.array(z.string().trim().min(1).max(16)).max(8).optional(),
  symbols: z.array(z.string().trim().min(1).max(20)).max(500).optional(),
  minDailyAmount: z.number().min(0).optional(),
});

const factorAstNodeSchema: z.ZodType<FactorAstNode> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal'), name: z.enum([
    'open', 'high', 'low', 'close', 'previousClose', 'volume', 'amount',
    'turnoverRatePct', 'totalMarketCap', 'returns', 'vwap', 'log_mktcap',
  ]) }),
  z.object({ type: z.literal('constant'), value: z.number().finite() }),
  z.object({
    type: z.literal('operator'), op: z.string().min(1).max(32),
    args: z.array(factorAstNodeSchema).max(8), window: z.number().int().min(2).max(252).optional(),
  }),
]));
const candidateBodySchema = z.object({
  taskId: z.string().uuid(), name: z.string().trim().min(1).max(255),
  formula: z.string().min(1).max(2000),
  expression: z.object({ type: z.literal('ast'), version: z.literal(1), root: factorAstNodeSchema }),
  direction: z.enum(['higher-is-better', 'lower-is-better', 'research']),
  validationMetrics: z.record(z.string(), z.unknown()),
  sourceLineage: z.record(z.string(), z.unknown()),
});
const candidateTestBodySchema = factorRunBodySchema.omit({ factorId: true });

async function runLockedCandidateTest(
  candidateId: string,
  definition: ReturnType<typeof candidateToFactorDefinition>,
  input: z.infer<typeof candidateTestBodySchema>,
  config: FactorResearchRouteConfig,
): Promise<void> {
  const report = await runFactorResearch({
    snapshotRoot: config.snapshotRoot, artifactRoot: config.artifactRoot,
    factorDefinition: definition,
    config: { factorId: definition.id, ...input }, writeReport: true,
  });
  assertLockedTestCoverage(report.summary);
  const persisted = await persistCompletedFactorRun(report, report.config);
  const [correlations, factorDecay] = await Promise.all([
    auditFactorCorrelations({ snapshotRoot: config.snapshotRoot, candidate: definition,
      references: listBuiltinFactors(), startDate: report.config.startDate, endDate: report.config.endDate }),
    auditFactorDecay({ snapshotRoot: config.snapshotRoot, factor: definition,
      startDate: report.config.startDate, endDate: report.config.endDate }),
  ]);
  const maxPublishedFactorCorrelation = correlations.reduce((max, item) =>
    item.correlation === null ? max : Math.max(max, Math.abs(item.correlation)), 0);
  const closestPublishedFactor = correlations.reduce<(typeof correlations)[number] | null>((closest, item) => {
    if (item.correlation === null) return closest;
    return !closest || closest.correlation === null
      || Math.abs(item.correlation) > Math.abs(closest.correlation) ? item : closest;
  }, null);
  await transitionFactorCandidate(candidateId, 'tested', {
    lockedTestMetrics: {
      ...report.summary,
      portfolio: report.portfolio,
      robustness: report.robustness,
      correlations,
      factorDecay,
      maxPublishedFactorCorrelation,
      marginalInformationIc: closestPublishedFactor?.marginalIc ?? null,
      closestPublishedFactorId: closestPublishedFactor?.factorId ?? null,
    },
    factorRunId: persisted.runId,
  });
}

export function registerFactorResearchRoutes(
  app: FastifyInstance,
  dbOnline: boolean,
  config: FactorResearchRouteConfig,
): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.get('/api/factors', stub);
    app.get('/api/factor-runs', stub);
    app.get('/api/factor-runs/:id/report', stub);
    app.get('/api/factor-runs/:id/report/daily', stub);
    app.post('/api/factor-runs/:id/interpret', stub);
    app.post('/api/factor-runs/:id/cancel', stub);
    app.post('/api/factor-runs/:id/retry', stub);
    app.post('/api/factor-runs', stub);
    app.post('/api/factor-composites', stub);
    app.get('/api/factor-candidates', stub);
    app.post('/api/factor-mining-tasks', stub);
    app.get('/api/factor-mining-tasks', stub);
    app.post('/api/factor-mining-tasks/:id/start', stub);
    app.post('/api/factor-mining-tasks/:id/resume', stub);
    app.post('/api/factor-mining-tasks/:id/cancel', stub);
    app.post('/api/factor-mining-tasks/:id/archive', stub);
    app.delete('/api/factor-mining-tasks/:id', stub);
    app.get('/api/factor-mining-tasks/:id/trace', stub);
    app.get('/api/factor-mining-schedules', stub);
    app.post('/api/factor-mining-schedules', stub);
    app.post('/api/factor-mining-schedules/:id/toggle', stub);
    app.post('/api/factor-candidates', stub);
    app.post('/api/factor-candidates/:id/freeze', stub);
    app.post('/api/factor-candidates/:id/test', stub);
    app.post('/api/factor-candidates/:id/approve', stub);
    app.post('/api/factor-candidates/:id/reject', stub);
    app.post('/api/factor-candidates/:id/publish', stub);
    return;
  }

  app.post<{ Body: { config?: Record<string, unknown>; lineage?: Record<string, unknown>;
    totalGenerations?: number; artifactUri?: string } }>('/api/factor-mining-tasks', async (req, reply) => {
    const current = await readCurrentSnapshot(config.snapshotRoot);
    if (!current) return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR, '没有已发布研究快照'));
    const task = await createMiningTask({
      snapshotId: current.manifest.snapshotId,
      config: req.body?.config ?? {},
      lineage: { ...(req.body?.lineage ?? {}), sourceVersion: current.manifest.sourceVersion },
      totalGenerations: Math.max(1, Math.min(10000, Number(req.body?.totalGenerations ?? 1))),
      artifactUri: req.body?.artifactUri,
    });
    return reply.status(201).send({ task });
  });

  app.get<{ Querystring: { limit?: string; includeArchived?: string } }>('/api/factor-mining-tasks', async (req, reply) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10) || 20));
    return reply.send({ items: await listMiningTasks(limit, req.query.includeArchived === 'true') });
  });

  app.get<{ Params: { id: string } }>('/api/factor-mining-tasks/:id/trace', async (req, reply) => {
    const task = await getMiningTask(req.params.id);
    if (!task) return reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '挖掘任务不存在'));
    if (!task.artifactUri) return reply.send({ items: [] });
    const path = resolve(task.artifactUri, 'evolution_trace.csv');
    const root = resolve(config.artifactRoot);
    const rel = relative(root, path);
    if (rel.startsWith('..') || rel.includes(':')) return reply.status(409).send(
      apiError(ErrorCodes.VALIDATION_ERROR, '任务轨迹路径越界'));
    try {
      const lines = (await readFile(path, 'utf8')).trim().split(/\r?\n/);
      if (lines.length < 2) return reply.send({ items: [] });
      const headers = lines[0].replace(/^\uFEFF/, '').split(',');
      const items = lines.slice(1).map((line) => Object.fromEntries(
        splitCsvLine(line).map((value, index) => [headers[index], value])));
      return reply.send({ items });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.send({ items: [] });
      throw error;
    }
  });

  app.get('/api/factor-mining-schedules', async (_req, reply) => reply.send({
    items: await listMiningSchedules(false),
  }));
  app.post<{ Body: { name?: string; config?: Record<string, unknown>; totalGenerations?: number } }>(
    '/api/factor-mining-schedules', async (req, reply) => {
      const current = await readCurrentSnapshot(config.snapshotRoot);
      if (!current) return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR, '没有已发布研究快照'));
      try {
        const schedule = await createMiningSchedule({ name: req.body?.name ?? '快照更新自动挖掘',
          config: req.body?.config ?? {}, totalGenerations: Math.max(2,
            Math.min(1000, Number(req.body?.totalGenerations ?? 40))),
          lastSnapshotId: current.manifest.snapshotId,
          lastTestEndDate: current.manifest.maxDate });
        return reply.status(201).send({ schedule });
      } catch (error) { return reply.status(400).send(apiError(ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : '调度配置无效')); }
    },
  );
  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/factor-mining-schedules/:id/toggle', async (req, reply) => {
      await updateMiningSchedule(req.params.id, { enabled: req.body?.enabled === false ? 0 : 1 });
      return reply.send({ updated: true });
    },
  );

  const launchMiningTask = async (id: string, resume: boolean) => startMiningWorker(id, {
    ...config.miningWorker,
    snapshotRoot: config.snapshotRoot,
    artifactRoot: config.artifactRoot,
  }, resume);

  app.post<{ Params: { id: string } }>('/api/factor-mining-tasks/:id/start', async (req, reply) => {
    try { return reply.status(202).send(await launchMiningTask(req.params.id, false)); }
    catch (error) { return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
      error instanceof Error ? error.message : '任务启动失败')); }
  });
  app.post<{ Params: { id: string } }>('/api/factor-mining-tasks/:id/resume', async (req, reply) => {
    try { return reply.status(202).send(await launchMiningTask(req.params.id, true)); }
    catch (error) { return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
      error instanceof Error ? error.message : '任务恢复失败')); }
  });
  app.post<{ Params: { id: string } }>('/api/factor-mining-tasks/:id/cancel', async (req, reply) => {
    const canceled = await cancelMiningWorker(req.params.id);
    return canceled ? reply.send({ canceled: true }) : reply.status(409).send(
      apiError(ErrorCodes.VALIDATION_ERROR, '任务未在当前服务进程运行'));
  });
  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>(
    '/api/factor-mining-tasks/:id/archive', async (req, reply) => {
      try {
        const task = await archiveMiningTask(req.params.id, req.body?.archived !== false);
        return task ? reply.send({ task }) : reply.status(404).send(
          apiError(ErrorCodes.RESULT_NOT_FOUND, '挖掘任务不存在'));
      } catch (error) { return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : '任务归档失败')); }
    },
  );
  app.delete<{ Params: { id: string } }>('/api/factor-mining-tasks/:id', async (req, reply) => {
    try {
      const task = await deleteMiningTask(req.params.id);
      return task ? reply.send({ deleted: true }) : reply.status(404).send(
        apiError(ErrorCodes.RESULT_NOT_FOUND, '挖掘任务不存在'));
    } catch (error) { return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
      error instanceof Error ? error.message : '任务删除失败')); }
  });

  app.get<{ Querystring: { taskId?: string; status?: 'draft' | 'frozen' | 'testing' | 'tested' | 'rejected' | 'approved' } }>(
    '/api/factor-candidates', async (req, reply) => reply.send({
      items: await listFactorCandidates(req.query.taskId, req.query.status),
    }),
  );

  app.post<{ Body: z.infer<typeof candidateBodySchema> }>('/api/factor-candidates', async (req, reply) => {
    const parsed = candidateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send(
      apiError(ErrorCodes.VALIDATION_ERROR, '候选因子参数无效', parsed.error.issues));
    try {
      return reply.status(201).send({ candidate: await createFactorCandidate(parsed.data) });
    } catch (error) {
      return reply.status(400).send(apiError(ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : '候选因子无效'));
    }
  });

  app.post<{ Params: { id: string } }>('/api/factor-candidates/:id/freeze', async (req, reply) => {
    try {
      const candidate = await transitionFactorCandidate(req.params.id, 'frozen', {});
      return candidate ? reply.send({ candidate }) : reply.status(404).send(
        apiError(ErrorCodes.RESULT_NOT_FOUND, '候选因子不存在'));
    } catch (error) {
      return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : '候选冻结失败'));
    }
  });

  app.post<{ Params: { id: string }; Body: z.infer<typeof candidateTestBodySchema> }>(
    '/api/factor-candidates/:id/test', async (req, reply) => {
      const parsed = candidateTestBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send(
        apiError(ErrorCodes.VALIDATION_ERROR, '锁定测试参数无效', parsed.error.issues));
      const candidate = await getFactorCandidate(req.params.id);
      if (!candidate) return reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '候选因子不存在'));
      if (candidate.status !== 'frozen') return reply.status(409).send(
        apiError(ErrorCodes.VALIDATION_ERROR, '只有 frozen 候选可以执行锁定测试'));
      try {
        assertLockedTestLineage(candidate.sourceLineage, parsed.data);
      } catch (error) {
        return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
          error instanceof Error ? error.message : '锁定测试血缘无效'));
      }
      const expression = candidate.expression as { root?: FactorAstNode };
      if (expression.root && factorAstRequiresMaterialization(expression.root)) {
        return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
          '该候选包含嵌套窗口算子，已保留；请先完成离线因子值物化后再执行锁定测试'));
      }
      try {
        await assertResearchSnapshotFresh(config.pool, config.snapshotRoot);
        const definition = candidateToFactorDefinition(candidate);
        const testingCandidate = await transitionFactorCandidate(candidate.id, 'testing', {});
        void runLockedCandidateTest(candidate.id, definition, parsed.data, config).catch(async (error) => {
          app.log.error({ err: error, candidateId: candidate.id }, 'Locked candidate test failed');
          try {
            const latest = await getFactorCandidate(candidate.id);
            if (latest?.status === 'testing') {
              await transitionFactorCandidate(candidate.id, 'rejected', {
                rejectionReason: `锁定测试执行失败：${error instanceof Error ? error.message : String(error)}`,
              });
            }
          } catch (statusError) {
            app.log.error({ err: statusError, candidateId: candidate.id },
              'Failed to persist locked candidate test failure');
          }
        });
        return reply.status(202).send({ candidate: testingCandidate });
      } catch (error) {
        req.log.error(error);
        return reply.status(503).send(apiError(ErrorCodes.INTERNAL_ERROR,
          error instanceof Error ? error.message : '锁定测试启动失败'));
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { approvedBy?: string } }>(
    '/api/factor-candidates/:id/approve', async (req, reply) => {
      try {
        const candidate = await transitionFactorCandidate(req.params.id, 'approved', {
          approvedBy: req.body?.approvedBy,
        });
        return candidate ? reply.send({ candidate }) : reply.status(404).send(
          apiError(ErrorCodes.RESULT_NOT_FOUND, '候选因子不存在'));
      } catch (error) {
        return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
          error instanceof Error ? error.message : '候选批准失败'));
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/factor-candidates/:id/reject', async (req, reply) => {
      try {
        const candidate = await transitionFactorCandidate(req.params.id, 'rejected', {
          rejectionReason: req.body?.reason,
        });
        return candidate ? reply.send({ candidate }) : reply.status(404).send(
          apiError(ErrorCodes.RESULT_NOT_FOUND, '候选因子不存在'));
      } catch (error) {
        return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
          error instanceof Error ? error.message : '候选拒绝失败'));
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/factor-candidates/:id/publish', async (req, reply) => {
    try {
      const published = await publishApprovedCandidate(req.params.id);
      return published ? reply.status(published.alreadyPublished ? 200 : 201).send(published)
        : reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '候选因子不存在'));
    } catch (error) {
      return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR,
        error instanceof Error ? error.message : '候选发布失败'));
    }
  });

  app.get('/api/factors', async (_req, reply) => {
    await syncBuiltinFactorCatalog();
    return reply.send({ items: await listFactorCatalog() });
  });

  app.get<{ Querystring: { limit?: string } }>('/api/factor-runs', async (req, reply) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10) || 20));
    return reply.send({ items: await listRecentFactorRuns(limit) });
  });

  app.get<{ Params: { id: string } }>('/api/factor-runs/:id/report', async (req, reply) => {
    try {
      const detail = await getFactorRunReport(req.params.id, config.artifactRoot);
      if (!detail) {
        return reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '因子报告不存在'));
      }
      return reply.send(detail);
    } catch (error) {
      req.log.error(error);
      return reply.status(503).send({
        message: error instanceof Error ? error.message : '因子报告读取失败',
      });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { page?: string; pageSize?: string };
  }>('/api/factor-runs/:id/report/daily', async (req, reply) => {
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize ?? '100', 10) || 100));
    try {
      const series = await getFactorRunDailySeries(req.params.id, config.artifactRoot, page, pageSize);
      if (!series) {
        return reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '因子报告不存在'));
      }
      return reply.send(series);
    } catch (error) {
      req.log.error(error);
      return reply.status(503).send({
        message: error instanceof Error ? error.message : '因子报告序列读取失败',
      });
    }
  });

  app.get('/api/factor-research/snapshot-freshness', async (_req, reply) => (
    reply.send(await getResearchSnapshotFreshness(config.pool, config.snapshotRoot))
  ));

  app.post<{ Params: { id: string } }>('/api/factor-runs/:id/interpret', async (req, reply) => {
    if (!config.ai.enabled) {
      return reply.status(503).send({ error: 'AI_NOT_ENABLED', message: 'AI 解读功能未启用' });
    }
    if (!config.ai.configured) {
      return reply.status(503).send({ error: 'AI_NOT_CONFIGURED', message: '请先配置大模型密钥' });
    }
    try {
      const [detail, dailySeries] = await Promise.all([
        getFactorRunReport(req.params.id, config.artifactRoot),
        getFactorRunDailySeries(req.params.id, config.artifactRoot, 1, 500),
      ]);
      if (!detail) {
        return reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '因子报告不存在'));
      }
      if (detail.run.status !== 'completed') {
        return reply.status(409).send(apiError(ErrorCodes.VALIDATION_ERROR, '仅支持解读已完成的因子报告'));
      }
      const result = await interpretFactorReport({
        apiKey: config.ai.apiKey,
        baseURL: config.ai.baseURL,
        model: config.ai.model,
        timeoutMs: config.ai.timeoutMs,
      }, {
        run: {
          id: detail.run.id,
          factorVersionId: detail.run.factorVersionId,
          snapshotId: detail.run.snapshotId,
          dateStart: detail.run.dateStart,
          dateEnd: detail.run.dateEnd,
          totalDates: detail.run.totalDates,
          completedDates: detail.run.completedDates,
        },
        report: detail.report,
        daily: dailySeries?.items ?? [],
      });
      return reply.send(result);
    } catch (error) {
      req.log.error(error);
      return reply.status(502).send({
        message: error instanceof Error ? error.message : '因子报告智能解读失败',
      });
    }
  });

  app.post<{ Params: { id: string } }>('/api/factor-runs/:id/cancel', async (req, reply) => {
    try {
      const result = await cancelFactorRun(req.params.id);
      if (!result) {
        return reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '因子任务不存在'));
      }
      if (!result.updated) {
        return reply.status(409).send({
          ...apiError(ErrorCodes.VALIDATION_ERROR, result.reason ?? '当前任务不可取消'),
          run: result.run,
        });
      }
      return reply.send({ run: result.run });
    } catch (error) {
      req.log.error(error);
      return reply.status(503).send({
        message: error instanceof Error ? error.message : '因子任务取消失败',
      });
    }
  });

  app.post<{ Params: { id: string } }>('/api/factor-runs/:id/retry', async (req, reply) => {
    const original = await getFactorRunById(req.params.id);
    if (!original) {
      return reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '因子任务不存在'));
    }
    if (!['failed', 'canceled', 'cancelled'].includes(original.status)) {
      return reply.status(409).send(
        apiError(ErrorCodes.VALIDATION_ERROR, `当前状态 ${original.status} 不支持重试`),
      );
    }

    const retryResult = parseStoredRunConfig(original.runConfig);
    if (!retryResult.ok) {
      return reply.status(400).send(
        apiError(ErrorCodes.VALIDATION_ERROR, retryResult.message, retryResult.issues),
      );
    }

    try {
      await syncBuiltinFactorCatalog();
      await assertResearchSnapshotFresh(config.pool, config.snapshotRoot);
      if (retryResult.kind === 'composite') {
        const report = await runCompositeFactorResearch({
          snapshotRoot: config.snapshotRoot,
          artifactRoot: config.artifactRoot,
          config: retryResult.config,
          writeReport: true,
        });
        const persisted = await persistCompletedCompositeFactorRun(report, report.config);
        return reply.status(201).send({ ...persisted, retriedFromRunId: original.id, report });
      }
      const report = await runFactorResearch({
        snapshotRoot: config.snapshotRoot,
        artifactRoot: config.artifactRoot,
        config: retryResult.config,
        writeReport: true,
      });
      const persisted = await persistCompletedFactorRun(report, report.config);
      return reply.status(201).send({ ...persisted, retriedFromRunId: original.id, report });
    } catch (error) {
      req.log.error(error);
      const failed = await persistFailedFactorRun(retryResult.config, error, original.snapshotId);
      return reply.status(503).send({
        message: error instanceof Error ? error.message : '因子任务重试失败',
        failedRunId: failed.runId,
      });
    }
  });

  app.post<{ Body: z.infer<typeof factorRunBodySchema> }>('/api/factor-runs', async (req, reply) => {
    const parsed = factorRunBodySchema.safeParse(req.body ?? {});
    if (!parsed.success || parsed.data.startDate > parsed.data.endDate) {
      return reply.status(400).send(
        apiError(ErrorCodes.VALIDATION_ERROR, '因子研究参数无效', parsed.success ? [] : parsed.error.issues),
      );
    }
    try {
      await syncBuiltinFactorCatalog();
      await assertResearchSnapshotFresh(config.pool, config.snapshotRoot);
      const report = await runFactorResearch({
        snapshotRoot: config.snapshotRoot,
        artifactRoot: config.artifactRoot,
        config: {
          factorId: parsed.data.factorId,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          horizonDays: parsed.data.horizonDays,
          layers: parsed.data.layers,
          markets: parsed.data.markets,
          symbols: parsed.data.symbols,
          minDailyAmount: parsed.data.minDailyAmount,
        },
        writeReport: true,
      });
      const persisted = await persistCompletedFactorRun(report, report.config);
      return reply.status(201).send({ ...persisted, report });
    } catch (error) {
      req.log.error(error);
      const failed = await persistFailedFactorRun(parsed.data, error);
      return reply.status(503).send({
        message: error instanceof Error ? error.message : '因子研究运行失败',
        failedRunId: failed.runId,
      });
    }
  });

  app.post<{ Body: z.infer<typeof compositeRunBodySchema> }>('/api/factor-composites', async (req, reply) => {
    const parsed = compositeRunBodySchema.safeParse(req.body ?? {});
    if (!parsed.success || parsed.data.startDate > parsed.data.endDate) {
      return reply.status(400).send(
        apiError(ErrorCodes.VALIDATION_ERROR, '多因子研究参数无效', parsed.success ? [] : parsed.error.issues),
      );
    }
    try {
      await assertResearchSnapshotFresh(config.pool, config.snapshotRoot);
      const report = await runCompositeFactorResearch({
        snapshotRoot: config.snapshotRoot,
        artifactRoot: config.artifactRoot,
        config: {
          factorIds: parsed.data.factorIds,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          validationStartDate: parsed.data.validationStartDate,
          horizonDays: parsed.data.horizonDays,
          layers: parsed.data.layers,
          weighting: parsed.data.weighting,
          manualWeights: parsed.data.manualWeights,
          markets: parsed.data.markets,
          symbols: parsed.data.symbols,
          minDailyAmount: parsed.data.minDailyAmount,
        },
        writeReport: true,
      });
      const persisted = await persistCompletedCompositeFactorRun(report, report.config);
      return reply.status(201).send({ ...persisted, report });
    } catch (error) {
      req.log.error(error);
      const failed = await persistFailedFactorRun(parsed.data, error);
      return reply.status(503).send({
        message: error instanceof Error ? error.message : '多因子研究运行失败',
        failedRunId: failed.runId,
      });
    }
  });
}

function parseStoredRunConfig(
  value: unknown,
): (
  | { ok: true; kind: 'single'; config: z.infer<typeof factorRunBodySchema> }
  | { ok: true; kind: 'composite'; config: z.infer<typeof compositeRunBodySchema> }
  | { ok: false; message: string; issues?: unknown }
) {
  if (value && typeof value === 'object' && Array.isArray((value as { factorIds?: unknown }).factorIds)) {
    const parsed = compositeRunBodySchema.safeParse(value);
    if (!parsed.success || parsed.data.startDate > parsed.data.endDate) {
      return {
        ok: false,
        message: '历史多因子任务配置无效，无法重试',
        issues: parsed.success ? [] : parsed.error.issues,
      };
    }
    return { ok: true, kind: 'composite', config: parsed.data };
  }
  const parsed = factorRunBodySchema.safeParse(value);
  if (!parsed.success || parsed.data.startDate > parsed.data.endDate) {
    return {
      ok: false,
      message: '历史因子任务配置无效，无法重试',
      issues: parsed.success ? [] : parsed.error.issues,
    };
  }
  return { ok: true, kind: 'single', config: parsed.data };
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = ''; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { values.push(value); value = ''; }
    else value += char;
  }
  values.push(value);
  return values;
}
