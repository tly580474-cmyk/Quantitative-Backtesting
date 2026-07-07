import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import { runFactorResearch } from '../factorResearch/engine/factorRunner.js';
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

interface FactorResearchRouteConfig {
  snapshotRoot: string;
  artifactRoot: string;
  pool: Pool;
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
    app.post('/api/factor-runs/:id/cancel', stub);
    app.post('/api/factor-runs/:id/retry', stub);
    app.post('/api/factor-runs', stub);
    app.post('/api/factor-composites', stub);
    return;
  }

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
