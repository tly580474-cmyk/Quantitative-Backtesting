import type { FastifyInstance } from 'fastify';
import {
  listVisualStrategies, getVisualStrategy, createVisualStrategy,
  deleteVisualStrategy, publishStrategy, getVersions, getVersion,
  saveDraft, getDraft, deleteDraft,
} from '../services/dataService.js';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';

export function registerVisualStrategyRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.get('/api/visual-strategies', stub);
    app.get('/api/visual-strategies/:id', stub);
    app.post('/api/visual-strategies', stub);
    app.delete('/api/visual-strategies/:id', stub);
    app.post('/api/visual-strategies/:id/publish', stub);
    app.get('/api/visual-strategies/:id/versions', stub);
    app.get('/api/visual-strategies/:id/versions/:version', stub);
    app.get('/api/visual-strategies/:id/draft', stub);
    app.put('/api/visual-strategies/:id/draft', stub);
    app.delete('/api/visual-strategies/:id/draft', stub);
    return;
  }

  app.get('/api/visual-strategies', async (_req, reply) => {
    const data = await listVisualStrategies();
    return reply.send(data);
  });

  app.get<{ Params: { id: string } }>('/api/visual-strategies/:id', async (req, reply) => {
    const vs = await getVisualStrategy(req.params.id);
    if (!vs) {
      return reply.status(404).send(apiError(ErrorCodes.STRATEGY_NOT_FOUND, '可视化策略不存在'));
    }
    return reply.send(vs);
  });

  app.post<{ Body: Record<string, unknown> }>('/api/visual-strategies', async (req, reply) => {
    await createVisualStrategy(req.body as never);
    return reply.status(201).send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/visual-strategies/:id', async (req, reply) => {
    await deleteVisualStrategy(req.params.id);
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string }; Body: { document: Record<string, unknown> } }>(
    '/api/visual-strategies/:id/publish',
    async (req, reply) => {
      const vs = await getVisualStrategy(req.params.id);
      if (!vs) {
        return reply.status(404).send(apiError(ErrorCodes.STRATEGY_NOT_FOUND, '可视化策略不存在'));
      }
      await publishStrategy(req.params.id, req.body.document);
      return reply.send({ ok: true });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/visual-strategies/:id/versions',
    async (req, reply) => {
      const versions = await getVersions(req.params.id);
      return reply.send(versions);
    },
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/api/visual-strategies/:id/versions/:version',
    async (req, reply) => {
      const v = await getVersion(req.params.id, parseInt(req.params.version, 10));
      if (!v) {
        return reply.status(404).send(apiError(ErrorCodes.STRATEGY_NOT_FOUND, '版本不存在'));
      }
      return reply.send(v);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/visual-strategies/:id/draft',
    async (req, reply) => {
      const draft = await getDraft(req.params.id);
      return reply.send(draft);
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/visual-strategies/:id/draft',
    async (req, reply) => {
      await saveDraft({
        id: req.body.id as string,
        strategyId: req.params.id,
        document: req.body.document as Record<string, unknown>,
        updatedAt: new Date().toISOString(),
      });
      return reply.send({ ok: true });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/visual-strategies/:id/draft',
    async (req, reply) => {
      await deleteDraft(req.params.id);
      return reply.send({ ok: true });
    },
  );
}
