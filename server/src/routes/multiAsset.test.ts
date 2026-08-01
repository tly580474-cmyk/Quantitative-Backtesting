import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerMultiAssetRoutes } from './multiAsset.js';

describe('multi-asset routes', () => {
  it('returns the standard unavailable response when the database is offline', async () => {
    const app = Fastify();
    registerMultiAssetRoutes(app, false, { snapshotRoot: './data/research-snapshots' });
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/multi-asset/plans' }),
      app.inject({ method: 'GET', url: '/api/multi-asset/runs' }),
      app.inject({ method: 'POST', url: '/api/multi-asset/plans', payload: {} }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: 'DB_UNAVAILABLE' });
    }
    await app.close();
  });
});
