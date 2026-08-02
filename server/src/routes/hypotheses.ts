import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  evaluateHypothesisRequestSchema,
  generateHypothesesRequestSchema,
  rejectHypothesisRequestSchema,
} from '../experiments/hypothesis/hypothesisSchema.js';
import {
  generateHypotheses,
  loadHypothesisCapabilityContext,
} from '../experiments/hypothesis/hypothesisGenerator.js';
import {
  createDefaultHypothesisEvaluationDeps,
  evaluateHypothesis,
} from '../experiments/hypothesis/hypothesisEvaluator.js';
import {
  createHypotheses,
  getHypothesis,
  listHypotheses,
  rejectHypothesis,
} from '../experiments/hypothesis/hypothesisRepository.js';
import type { HypothesisLlmProvider } from '../experiments/hypothesis/hypothesisLlm.js';
import { apiError, dbUnavailable, ErrorCodes } from '../validation/errors.js';

export interface HypothesisRouteOptions {
  provider: HypothesisLlmProvider;
  hypothesisEnabled: boolean;
  pythonExecutable: string;
}

function validationError(reply: FastifyReply, issues: unknown) {
  return reply.status(400).send(apiError(
    ErrorCodes.VALIDATION_ERROR,
    '假设请求未通过校验',
    issues,
  ));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerHypothesisRoutes(
  app: FastifyInstance,
  dbOnline: boolean,
  options: HypothesisRouteOptions,
): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.post('/api/hypotheses/generate', stub);
    app.get('/api/hypotheses', stub);
    app.get('/api/hypotheses/:id', stub);
    app.post('/api/hypotheses/:id/evaluate', stub);
    app.post('/api/hypotheses/:id/reject', stub);
    return;
  }

  app.post('/api/hypotheses/generate', async (req, reply) => {
    const parsed = generateHypothesesRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const capabilityContext = await loadHypothesisCapabilityContext(dbOnline);
    let generated;
    try {
      generated = await generateHypotheses({
        provider: options.provider,
        capabilityContext,
        request: parsed.data,
      });
    } catch (error) {
      return reply.status(502).send(apiError(
        ErrorCodes.HYPOTHESIS_GENERATION_FAILED,
        '假设生成失败',
        { message: errorMessage(error) },
      ));
    }
    const records = await createHypotheses({
      plans: generated.plans,
      capabilityVersion: generated.plans[0]?.capabilityVersion ?? 'local-capabilities-v1',
    });
    return reply.status(201).send({ hypotheses: records, rejected: generated.rejected });
  });

  app.get<{ Querystring: { limit?: string } }>('/api/hypotheses', async (req, reply) => {
    const limit = Number.parseInt(req.query.limit ?? '100', 10);
    return reply.send({ hypotheses: await listHypotheses(limit) });
  });

  app.get<{ Params: { id: string } }>('/api/hypotheses/:id', async (req, reply) => {
    const hypothesis = await getHypothesis(req.params.id);
    if (!hypothesis) {
      return reply.status(404).send(apiError(ErrorCodes.HYPOTHESIS_NOT_FOUND, '假设不存在'));
    }
    return reply.send({ hypothesis });
  });

  app.post<{ Params: { id: string } }>('/api/hypotheses/:id/evaluate', async (req, reply) => {
    const parsed = evaluateHypothesisRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    if (!options.hypothesisEnabled) {
      return reply.status(503).send(apiError(
        ErrorCodes.HYPOTHESIS_BACKTEST_FAILED,
        '假设评估未启用（EXPERIMENT_HYPOTHESIS_ENABLED=false）',
      ));
    }
    const hypothesis = await getHypothesis(req.params.id);
    if (!hypothesis) {
      return reply.status(404).send(apiError(ErrorCodes.HYPOTHESIS_NOT_FOUND, '假设不存在'));
    }
    if (hypothesis.status !== 'draft') {
      return reply.status(409).send(apiError(
        ErrorCodes.HYPOTHESIS_INVALID_STATE,
        `只有草稿状态的假设可以评估（当前 ${hypothesis.status}）`,
      ));
    }
    try {
      const outcome = await evaluateHypothesis({
        hypothesisId: hypothesis.id,
        plan: hypothesis.plan,
        request: parsed.data,
        deps: createDefaultHypothesisEvaluationDeps({
          enabled: true,
          pythonExecutable: options.pythonExecutable,
        }),
      });
      return reply.send({ outcome });
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith('HYPOTHESIS_INVALID_STATE')) {
        return reply.status(409).send(apiError(ErrorCodes.HYPOTHESIS_INVALID_STATE, '只有草稿状态的假设可以评估'));
      }
      if (message.startsWith('HYPOTHESIS_BACKTEST_FAILED')) {
        return reply.status(502).send(apiError(ErrorCodes.HYPOTHESIS_BACKTEST_FAILED, '假设回测执行失败', { message }));
      }
      if (message.startsWith('HYPOTHESIS_NOT_FOUND')) {
        return reply.status(404).send(apiError(ErrorCodes.HYPOTHESIS_NOT_FOUND, '假设不存在'));
      }
      return reply.status(409).send(apiError(
        ErrorCodes.HYPOTHESIS_INVALID_STATE,
        '假设评估未完成',
        { message },
      ));
    }
  });

  app.post<{ Params: { id: string } }>('/api/hypotheses/:id/reject', async (req, reply) => {
    const parsed = rejectHypothesisRequestSchema.safeParse(req.body);
    if (!parsed.success) return validationError(reply, parsed.error.issues);
    const hypothesis = await getHypothesis(req.params.id);
    if (!hypothesis) {
      return reply.status(404).send(apiError(ErrorCodes.HYPOTHESIS_NOT_FOUND, '假设不存在'));
    }
    try {
      const updated = await rejectHypothesis(req.params.id, parsed.data.reason);
      return reply.send({ hypothesis: updated });
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith('HYPOTHESIS_INVALID_STATE')) {
        return reply.status(409).send(apiError(ErrorCodes.HYPOTHESIS_INVALID_STATE, '只有草稿状态的假设可以拒绝'));
      }
      throw error;
    }
  });
}
