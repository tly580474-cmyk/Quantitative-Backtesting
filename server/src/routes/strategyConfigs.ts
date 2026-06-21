import type { FastifyInstance } from 'fastify';
import {
  listStrategyConfigs, getStrategyConfig, createStrategyConfig, deleteStrategyConfig,
} from '../services/dataService.js';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';

export function registerStrategyConfigRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.get('/api/strategy-configs', stub);
    app.get('/api/strategy-configs/:id', stub);
    app.post('/api/strategy-configs', stub);
    app.delete('/api/strategy-configs/:id', stub);
    return;
  }

  app.get('/api/strategy-configs', async (_req, reply) => {
    const data = await listStrategyConfigs();
    return reply.send(data);
  });

  app.get<{ Params: { id: string } }>('/api/strategy-configs/:id', async (req, reply) => {
    const config = await getStrategyConfig(req.params.id);
    if (!config) {
      return reply.status(404).send(apiError(ErrorCodes.CONFIG_NOT_FOUND, '策略配置不存在'));
    }
    return reply.send(config);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/strategy-configs', async (req, reply) => {
    await createStrategyConfig(req.body as never);
    return reply.status(201).send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/strategy-configs/:id', async (req, reply) => {
    await deleteStrategyConfig(req.params.id);
    return reply.send({ ok: true });
  });
}
