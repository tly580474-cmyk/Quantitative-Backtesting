import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { evaluateAutoCandidateGate } from '../factorResearch/candidates/autoCandidateGate.js';
import {
  evaluateStrategyPromotion,
  nextStrategyStatus,
  validateCompositeWeights,
} from '../factorResearch/strategies/strategyGovernance.js';
import {
  addPaperObservation,
  addStrategyEvaluation,
  createStrategyVersion,
  getStrategyPerformance,
  getStrategyVersion,
  listStrategyVersions,
  promoteStrategy,
  updateStrategyStatus,
} from '../factorResearch/strategies/strategyRepository.js';
import { runPortfolioOptimizer } from '../factorResearch/portfolio/optimizerWorker.js';
import { join } from 'node:path';

const factorSchema = z.object({
  versionId: z.string().min(1).max(96),
  family: z.string().min(1).max(64),
  weight: z.number().min(0).max(0.30),
});
const buildSchema = z.object({
  name: z.string().trim().min(1).max(255),
  parentVersionId: z.string().uuid().nullable().default(null),
  factors: z.array(factorSchema).min(5).max(8),
  snapshotId: z.string().min(1).max(128),
  codeChecksum: z.string().regex(/^[a-fA-F0-9]{64}$/),
  randomSeeds: z.array(z.number().int()).length(3).default([20260710, 20260711, 20260712]),
});
const promotionSchema = z.object({
  approvedBy: z.string().trim().min(1).max(128),
  reason: z.string().max(1000).optional(),
  metrics: z.object({
    paperRebalanceCycles: z.number().int().min(0),
    annualExcessEligibleUniverse: z.number(),
    annualExcessCsi500: z.number(),
    informationRatioEligibleUniverse: z.number(),
    informationRatioCsi500: z.number(),
    maxDrawdown: z.number(),
    stressedCostCumulativeReturn: z.number(),
    positiveHistoricalRegimes: z.number().int(),
    historicalRegimeCount: z.number().int(),
    paperCumulativeExcessEligibleUniverse: z.number(),
    paperCumulativeExcessCsi500: z.number(),
    violations: z.array(z.string()).default([]),
  }),
});

export function registerFactorStrategyRoutes(app: FastifyInstance, pool: Pool, worker?: {
  pythonExecutable: string; minerRoot: string; timeoutMs: number;
}): void {
  app.get('/api/factor-strategies', async () => ({ items: await listStrategyVersions(pool) }));

  app.post<{ Body: Record<string, unknown> }>('/api/factor-strategies/optimize', async (req) => {
    if (!worker) throw Object.assign(new Error('portfolio optimizer is not configured'), { statusCode: 503 });
    const result = await runPortfolioOptimizer({
      payload: req.body,
      pythonExecutable: worker.pythonExecutable,
      workerPath: join(worker.minerRoot, 'portfolio_worker.py'),
      timeoutMs: Math.min(worker.timeoutMs, 120_000),
    });
    return {
      result,
      failureAction: result.status === 'failed' ? 'hold-existing-positions-and-alert' : null,
    };
  });

  app.post<{ Body: z.infer<typeof buildSchema> }>('/api/factor-strategies', async (req, reply) => {
    const input = buildSchema.parse(req.body);
    validateCompositeWeights(input.factors);
    const compositeWeights = Object.fromEntries(input.factors.map((factor) =>
      [factor.versionId, factor.weight]));
    const strategy = await createStrategyVersion(pool, {
      name: input.name, parentVersionId: input.parentVersionId,
      factorVersions: input.factors, compositeWeights,
      universeConfig: {
        markets: ['SH', 'SZ'], excludeSt: true, listedDays: 365,
        excludeBeijing: true, excludeStar: true, minPrice: 1.2,
        minAverageAmount20: 20_000_000, rebalanceTradingDays: 20,
        signalAt: 'T_CLOSE', executeAt: 'T_PLUS_1_OPEN',
      },
      preprocessingConfig: {
        winsor: [0.01, 0.99], standardize: true, industryNeutral: true,
        marketCapNeutralForNonSize: true, factorCoverage: 0.70, compositeCoverage: 0.80,
      },
      optimizerConfig: {
        topBeforeOptimize: 50, holdings: 30, covarianceDays: 120,
        covariance: 'ledoit-wolf', minWeight: 0.01, maxWeight: 0.05,
        industryDeviation: 0.10, styleExposure: 0.5, maxAnnualVolatility: 0.25,
        maxTrackingError: 0.15, maxOneWayTurnover: 0.40, maxAdvParticipation: 0.05,
        failurePolicy: 'hold-and-alert',
      },
      costConfig: { buyBps: 8, sellBps: 13, stressMultiplier: 2 },
      snapshotId: input.snapshotId, codeChecksum: input.codeChecksum,
      randomSeeds: input.randomSeeds,
    });
    return reply.code(201).send({ strategy });
  });

  app.post<{ Params: { id: string }; Body: {
    validationMetrics: Record<string, unknown>; lockedTestMetrics: Record<string, unknown>;
    artifactUri?: string;
  } }>('/api/factor-strategies/:id/evaluate', async (req) => {
    const strategy = await requireStrategy(pool, req.params.id);
    if (strategy.status !== 'draft') throw Object.assign(new Error('strategy is not draft'), { statusCode: 409 });
    const gate = evaluateAutoCandidateGate(req.body.validationMetrics, req.body.lockedTestMetrics);
    await addStrategyEvaluation(pool, {
      strategyVersionId: strategy.id, evaluationType: 'locked-test',
      metrics: req.body, gateResult: gate, artifactUri: req.body.artifactUri,
    });
    const updated = gate.passed
      ? await updateStrategyStatus(pool, strategy.id, nextStrategyStatus(strategy.status, 'validate'))
      : strategy;
    return { strategy: updated, gate };
  });

  app.post<{ Params: { id: string }; Body: { paperAccountId: string } }>(
    '/api/factor-strategies/:id/start-paper', async (req) => {
      const strategy = await requireStrategy(pool, req.params.id);
      if (strategy.status !== 'validated') {
        throw Object.assign(new Error('only a validated strategy can start paper observation'),
          { statusCode: 409 });
      }
      const updated = await updateStrategyStatus(pool, strategy.id,
        nextStrategyStatus(strategy.status, 'startPaper'), req.body.paperAccountId);
      return { strategy: updated, initialCapital: 1_000_000 };
    },
  );

  app.post<{ Params: { id: string }; Body: {
    rebalanceCycle: number; observationDate: string; metrics: Record<string, unknown>;
    violations?: string[];
  } }>('/api/factor-strategies/:id/observations', async (req) => {
    const strategy = await requireStrategy(pool, req.params.id);
    if (strategy.status !== 'paper' && strategy.status !== 'champion') {
      throw Object.assign(new Error('strategy is not under paper observation'), { statusCode: 409 });
    }
    await addPaperObservation(pool, {
      strategyVersionId: strategy.id, rebalanceCycle: req.body.rebalanceCycle,
      observationDate: req.body.observationDate, metrics: req.body.metrics,
      violations: req.body.violations ?? [],
    });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/factor-strategies/:id/performance', async (req) => ({
    strategy: await requireStrategy(pool, req.params.id),
    ...await getStrategyPerformance(pool, req.params.id),
  }));

  app.post<{ Params: { id: string }; Body: z.infer<typeof promotionSchema> }>(
    '/api/factor-strategies/:id/promote', async (req) => {
      const strategy = await requireStrategy(pool, req.params.id);
      if (strategy.status !== 'paper') {
        throw Object.assign(new Error('only a paper strategy can be promoted'), { statusCode: 409 });
      }
      const input = promotionSchema.parse(req.body);
      const performance = await getStrategyPerformance(pool, strategy.id);
      const observedCycles = performance.observations.length
        ? Math.max(...performance.observations.map((row) => Number(row.rebalanceCycle))) : 0;
      const recordedViolations = performance.observations.flatMap((row) =>
        Array.isArray(row.violations) ? row.violations.map(String) : []);
      const metrics = { ...input.metrics,
        paperRebalanceCycles: Math.min(input.metrics.paperRebalanceCycles, observedCycles),
        violations: [...new Set([...input.metrics.violations, ...recordedViolations])] };
      const gate = evaluateStrategyPromotion(metrics);
      if (!gate.passed) return { strategy, gate };
      const promoted = await promoteStrategy(pool, {
        strategyVersionId: strategy.id, approvedBy: input.approvedBy,
        reason: input.reason, gateResult: gate,
      });
      return { strategy: promoted, gate };
    },
  );
}

async function requireStrategy(pool: Pool, id: string) {
  const strategy = await getStrategyVersion(pool, id);
  if (!strategy) throw Object.assign(new Error('strategy version not found'), { statusCode: 404 });
  return strategy;
}
