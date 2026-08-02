import type { FastifyInstance } from 'fastify';
import type { StrategyGenerationProvider } from '../services/strategyGeneration/provider.js';
import { buildStrategyCapabilityRegistry } from '../services/strategyGeneration/capabilityRegistry.js';
import {
  classifyStrategyOutputError,
  isExperimentErrorCategory,
  EXPERIMENT_ERROR_CATEGORY_META,
} from '../experiments/errorClassification.js';
import {
  interpretError,
  fallbackInterpretation,
  type ErrorInterpreterProvider,
  type ErrorInterpreterRequest,
} from '../services/strategyGeneration/errorInterpreter.js';

/**
 * Register AI strategy generation routes on the Fastify app.
 */
export function registerAiRoutes(
  app: FastifyInstance,
  provider: StrategyGenerationProvider,
  aiEnabled: boolean,
  aiConfigured: boolean,
  currentModel: string,
  availableModels: string[],
  loadPublishedFactorVersionIds: () => Promise<string[]> = async () => [],
  interpreter?: ErrorInterpreterProvider,
): void {
  // GET /api/ai/status
  app.get('/api/ai/status', async (_req, reply) => {
    return reply.send({
      enabled: aiEnabled,
      configured: aiConfigured,
      provider: aiConfigured ? 'openai' : 'mock',
      currentModel,
      availableModels,
    });
  });

  // Generated from the executable indicator registry; never maintain a second
  // hand-written capability list in prompts or routes.
  app.get('/api/ai/strategy-capabilities', async (_req, reply) => {
    return reply.send(buildStrategyCapabilityRegistry(
      await loadPublishedFactorVersionIds(),
    ));
  });

  // POST /api/ai/errors/interpret — N4.2: 中文解释 Agent（确定性兜底始终可用）
  app.post('/api/ai/errors/interpret', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.category !== 'string' || !isExperimentErrorCategory(body.category)) {
      return reply.status(400).send({ error: 'INVALID_CATEGORY', message: '错误类别不在已知枚举中' });
    }
    const request: ErrorInterpreterRequest = {
      category: body.category,
      issues: Array.isArray(body.issues)
        ? body.issues.filter((item): item is string => typeof item === 'string').slice(0, 50)
        : [],
      fieldPaths: Array.isArray(body.fieldPaths)
        ? body.fieldPaths.filter((item): item is string => typeof item === 'string').slice(0, 20)
        : [],
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      capabilitySummary: typeof body.capabilitySummary === 'string' ? body.capabilitySummary : undefined,
    };
    const interpretation = interpreter
      ? await interpretError({ request, provider: interpreter })
      : fallbackInterpretation(request);
    return reply.send({ interpretation });
  });

  // POST /api/ai/strategies/generate
  app.post('/api/ai/strategies/generate', async (req, reply) => {
    if (!aiEnabled) {
      return reply.status(503).send({
        error: 'AI_NOT_ENABLED',
        message: 'AI 策略生成功能未启用',
      });
    }

    const body = req.body as Record<string, unknown>;
    if (!body.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
      return reply.status(400).send({
        error: 'INVALID_PROMPT',
        message: '请提供有效的策略描述',
      });
    }

    if (body.prompt.length > 2000) {
      return reply.status(400).send({
        error: 'PROMPT_TOO_LONG',
        message: '策略描述不能超过 2000 个字符',
      });
    }

    if (body.model !== undefined && (
      typeof body.model !== 'string' || !availableModels.includes(body.model)
    )) {
      return reply.status(400).send({
        error: 'INVALID_MODEL',
        message: '请求的模型不在允许列表中',
      });
    }

    try {
      const result = await provider.generate({
        prompt: body.prompt as string,
        model: body.model as string | undefined,
        datasetContext: body.datasetContext as { timeframe: string; availableFields: string[] } | undefined,
        dslVersion: (body.dslVersion as string) ?? '1.0',
      });
      if (result.repairAudit) {
        req.log.info({
          event: 'strategy_schema_repair',
          generationId: result.generationId,
          audit: result.repairAudit,
        }, 'Strategy schema repair audit');
      }

      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err: message }, 'AI generation failed');
      const classified = classifyStrategyOutputError(err);
      return reply.status(classified.category === 'SCHEMA_INVALID' ? 422 : 500).send({
        error: classified.category,
        message: classified.message,
        details: {
          category: classified.category,
          categoryLabel: EXPERIMENT_ERROR_CATEGORY_META[classified.category].label,
          fieldPaths: classified.fieldPaths,
          issues: classified.issues,
        },
      });
    }
  });

  // POST /api/ai/strategies/refine
  app.post('/api/ai/strategies/refine', async (req, reply) => {
    if (!aiEnabled) {
      return reply.status(503).send({ error: 'AI_NOT_ENABLED', message: 'AI 策略生成功能未启用' });
    }

    const body = req.body as Record<string, unknown>;
    if (
      !body.currentStrategy
      || typeof body.modification !== 'string'
      || body.modification.trim().length === 0
    ) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: '请提供当前策略和有效的修改要求' });
    }

    if (body.modification.length > 2000) {
      return reply.status(400).send({ error: 'MODIFICATION_TOO_LONG', message: '修改要求不能超过 2000 个字符' });
    }

    if (body.model !== undefined && (
      typeof body.model !== 'string' || !availableModels.includes(body.model)
    )) {
      return reply.status(400).send({ error: 'INVALID_MODEL', message: '请求的模型不在允许列表中' });
    }

    try {
      const result = await provider.refine({
        currentStrategy: body.currentStrategy as Record<string, unknown>,
        modification: body.modification as string,
        model: body.model as string | undefined,
        dslVersion: (body.dslVersion as string) ?? '1.0',
      });
      if (result.repairAudit) {
        req.log.info({
          event: 'strategy_schema_repair',
          generationId: result.generationId,
          audit: result.repairAudit,
        }, 'Strategy schema repair audit');
      }
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err: message }, 'AI refinement failed');
      const classified = classifyStrategyOutputError(err);
      return reply.status(classified.category === 'SCHEMA_INVALID' ? 422 : 500).send({
        error: classified.category,
        message: classified.message,
        details: {
          category: classified.category,
          categoryLabel: EXPERIMENT_ERROR_CATEGORY_META[classified.category].label,
          fieldPaths: classified.fieldPaths,
          issues: classified.issues,
        },
      });
    }
  });

  // POST /api/ai/strategies/explain
  app.post('/api/ai/strategies/explain', async (req, reply) => {
    if (!aiEnabled) {
      return reply.status(503).send({ error: 'AI_NOT_ENABLED', message: 'AI 策略生成功能未启用' });
    }

    const body = req.body as Record<string, unknown>;
    if (!body.strategy) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: '缺少策略数据' });
    }

    try {
      const result = await provider.explain({
        strategy: body.strategy as Record<string, unknown>,
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'EXPLAIN_FAILED', message: '策略解释失败' });
    }
  });
}
