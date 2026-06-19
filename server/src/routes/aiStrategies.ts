import type { FastifyInstance } from 'fastify';
import type { StrategyGenerationProvider } from '../services/strategyGeneration/provider.js';

/**
 * Register AI strategy generation routes on the Fastify app.
 */
export function registerAiRoutes(
  app: FastifyInstance,
  provider: StrategyGenerationProvider,
  aiEnabled: boolean,
  aiConfigured: boolean,
): void {
  // GET /api/ai/status
  app.get('/api/ai/status', async (_req, reply) => {
    return reply.send({
      enabled: aiEnabled,
      configured: aiConfigured,
      provider: aiConfigured ? 'openai' : 'mock',
    });
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

    try {
      const result = await provider.generate({
        prompt: body.prompt as string,
        datasetContext: body.datasetContext as { timeframe: string; availableFields: string[] } | undefined,
        dslVersion: (body.dslVersion as string) ?? '1.0',
      });

      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err: message }, 'AI generation failed');
      return reply.status(500).send({
        error: 'GENERATION_FAILED',
        message: '策略生成失败，请稍后重试',
      });
    }
  });

  // POST /api/ai/strategies/refine
  app.post('/api/ai/strategies/refine', async (req, reply) => {
    if (!aiEnabled) {
      return reply.status(503).send({ error: 'AI_NOT_ENABLED', message: 'AI 策略生成功能未启用' });
    }

    const body = req.body as Record<string, unknown>;
    if (!body.currentStrategy || !body.modification) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: '缺少必要参数' });
    }

    try {
      const result = await provider.refine({
        currentStrategy: body.currentStrategy as Record<string, unknown>,
        modification: body.modification as string,
        dslVersion: (body.dslVersion as string) ?? '1.0',
      });
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err: message }, 'AI refinement failed');
      return reply.status(500).send({ error: 'REFINEMENT_FAILED', message: '策略修改失败' });
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
