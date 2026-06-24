import type { FastifyInstance } from 'fastify';
import { listDatasets, getCandles, listResults, getEquityPoints } from '../services/dataService.js';
import { listStrategyConfigs } from '../services/dataService.js';
import { listVisualStrategies, getVersions, getDraft } from '../services/dataService.js';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';

const EXPORT_PAGE_SIZE = 10000;

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
      const rows: unknown[] = [];
      let offset = 0;
      let total = 0;
      do {
        const result = await getCandles(ds.id, offset, EXPORT_PAGE_SIZE);
        rows.push(...result.data);
        total = result.total;
        if (result.data.length === 0) break;
        offset += result.data.length;
      } while (offset < total);
      candlesByDataset[ds.id] = rows;
    }

    const results = await listResults();
    const equityByResult: Record<string, unknown[]> = {};
    for (const r of results) {
      const rows: unknown[] = [];
      let offset = 0;
      let total = 0;
      do {
        const result = await getEquityPoints(r.id, offset, EXPORT_PAGE_SIZE);
        rows.push(...result.data);
        total = result.total;
        if (result.data.length === 0) break;
        offset += result.data.length;
      } while (offset < total);
      equityByResult[r.id] = rows;
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
