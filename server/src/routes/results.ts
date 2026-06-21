import type { FastifyInstance } from 'fastify';
import {
  listResults, getResult, createResult, deleteResult,
  bulkDeleteResults, getEquityPoints,
} from '../services/dataService.js';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';

export function registerResultRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.get('/api/results', stub);
    app.get('/api/results/:id', stub);
    app.post('/api/results', stub);
    app.delete('/api/results/:id', stub);
    app.post('/api/results/bulk-delete', stub);
    app.get('/api/results/:id/equity-points', stub);
    return;
  }

  app.get('/api/results', async (_req, reply) => {
    const data = await listResults();
    return reply.send(data);
  });

  app.get<{ Params: { id: string } }>('/api/results/:id', async (req, reply) => {
    const result = await getResult(req.params.id);
    if (!result) {
      return reply.status(404).send(apiError(ErrorCodes.RESULT_NOT_FOUND, '回测结果不存在'));
    }
    return reply.send(result);
  });

  app.post<{ Body: { result: Record<string, unknown>; equityPoints: Record<string, unknown>[] } }>(
    '/api/results',
    async (req, reply) => {
      await createResult(req.body.result as never, req.body.equityPoints as never[]);
      return reply.status(201).send({ ok: true });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/results/:id', async (req, reply) => {
    await deleteResult(req.params.id);
    return reply.send({ ok: true });
  });

  app.post<{ Body: { ids: string[] } }>('/api/results/bulk-delete', async (req, reply) => {
    await bulkDeleteResults(req.body.ids);
    return reply.send({ ok: true });
  });

  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/results/:id/equity-points',
    async (req, reply) => {
      const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10) || 0);
      const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit ?? '1000', 10) || 1000));
      const result = await getEquityPoints(req.params.id, offset, limit);
      return reply.send(result);
    },
  );
}
