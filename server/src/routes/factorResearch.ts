import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import { runFactorResearch } from '../factorResearch/engine/factorRunner.js';
import { runCompositeFactorResearch } from '../factorResearch/engine/compositeRunner.js';
import {
  listFactorCatalog,
  listRecentFactorRuns,
  persistCompletedFactorRun,
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

  app.get('/api/factor-research/snapshot-freshness', async (_req, reply) => (
    reply.send(await getResearchSnapshotFreshness(config.pool, config.snapshotRoot))
  ));

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
      return reply.status(503).send({
        message: error instanceof Error ? error.message : '因子研究运行失败',
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
      return reply.status(201).send({ report });
    } catch (error) {
      req.log.error(error);
      return reply.status(503).send({
        message: error instanceof Error ? error.message : '多因子研究运行失败',
      });
    }
  });
}
