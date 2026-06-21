import type { FastifyInstance } from 'fastify';
import { listDatasets, getCandles, listResults, getEquityPoints } from '../services/dataService.js';
import { listStrategyConfigs } from '../services/dataService.js';
import { listVisualStrategies, getVersions, getDraft } from '../services/dataService.js';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';

export function registerExportRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    app.get('/api/export/excel', async () => {
      throw { statusCode: 503, ...dbUnavailable() };
    });
    return;
  }

  // Returns JSON export of all tables (for client-side Excel generation)
  app.get('/api/export/all', async (_req, reply) => {
    const datasets = await listDatasets();

    // Gather candles per dataset
    const candlesByDataset: Record<string, unknown[]> = {};
    for (const ds of datasets) {
      const { data } = await getCandles(ds.id, 0, 100000);
      candlesByDataset[ds.id] = data;
    }

    const results = await listResults();
    const equityByResult: Record<string, unknown[]> = {};
    for (const r of results) {
      const { data } = await getEquityPoints(r.id, 0, 100000);
      equityByResult[r.id] = data;
    }

    const configs = await listStrategyConfigs();
    const strategies = await listVisualStrategies();

    const versionsByStrategy: Record<string, unknown[]> = {};
    const draftsByStrategy: Record<string, unknown[]> = {};
    for (const vs of strategies) {
      versionsByStrategy[vs.id] = await getVersions(vs.id);
      const draft = await getDraft(vs.id);
      if (draft) draftsByStrategy[vs.id] = [draft];
    }

    return reply.send({
      datasets,
      candlesByDataset,
      results,
      equityByResult,
      configs,
      strategies,
      versionsByStrategy,
      draftsByStrategy,
    });
  });
}
