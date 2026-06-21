import type { FastifyInstance } from 'fastify';
import {
  listDatasets, getDataset, createDataset, deleteDataset,
  getCandles, findDuplicateByChecksum,
} from '../services/dataService.js';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';

export function registerDatasetRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    // Register stubs that return 503
    const stub = async () => {
      throw { statusCode: 503, ...dbUnavailable() };
    };
    app.get('/api/datasets', stub);
    app.get('/api/datasets/:id', stub);
    app.post('/api/datasets', stub);
    app.delete('/api/datasets/:id', stub);
    app.get('/api/datasets/:id/candles', stub);
    app.post('/api/datasets/check-duplicate', stub);
    return;
  }

  app.get('/api/datasets', async (_req, reply) => {
    try {
      const data = await listDatasets();
      return reply.send(data);
    } catch (err) {
      throw { statusCode: 500, ...apiError(ErrorCodes.INTERNAL_ERROR, '查询数据集失败') };
    }
  });

  app.get<{ Params: { id: string } }>('/api/datasets/:id', async (req, reply) => {
    const ds = await getDataset(req.params.id);
    if (!ds) {
      return reply.status(404).send(apiError(ErrorCodes.DATASET_NOT_FOUND, '数据集不存在'));
    }
    return reply.send(ds);
  });

  app.post<{ Body: { dataset: Record<string, unknown>; candles: Record<string, unknown>[] } }>(
    '/api/datasets',
    async (req, reply) => {
      try {
        await createDataset(req.body.dataset as never, req.body.candles as never[]);
        return reply.status(201).send({ ok: true });
      } catch (err) {
        throw { statusCode: 500, ...apiError(ErrorCodes.INTERNAL_ERROR, '创建数据集失败') };
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/datasets/:id', async (req, reply) => {
    try {
      await deleteDataset(req.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      throw { statusCode: 500, ...apiError(ErrorCodes.INTERNAL_ERROR, '删除数据集失败') };
    }
  });

  app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/datasets/:id/candles',
    async (req, reply) => {
      const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10) || 0);
      const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit ?? '1000', 10) || 1000));
      const result = await getCandles(req.params.id, offset, limit);
      return reply.send(result);
    },
  );

  app.post<{ Body: { checksum: string } }>(
    '/api/datasets/check-duplicate',
    async (req, reply) => {
      const ds = await findDuplicateByChecksum(req.body.checksum);
      return reply.send({ duplicate: ds != null, dataset: ds });
    },
  );
}
