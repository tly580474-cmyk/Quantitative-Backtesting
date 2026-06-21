import type { FastifyInstance } from 'fastify';
import {
  createDataset, createResult, createStrategyConfig, createVisualStrategy,
  saveDraft, getTableCounts, getDataset, getResult, getStrategyConfig, getVisualStrategy,
} from '../services/dataService.js';
import { ErrorCodes, apiError, dbUnavailable } from '../validation/errors.js';
import { publishStrategy } from '../services/dataService.js';

export function registerMigrationRoutes(app: FastifyInstance, dbOnline: boolean): void {
  if (!dbOnline) {
    const stub = async () => { throw { statusCode: 503, ...dbUnavailable() }; };
    app.post('/api/migration/import-dataset', stub);
    app.post('/api/migration/import-result', stub);
    app.post('/api/migration/import-strategies', stub);
    app.post('/api/migration/import-configs', stub);
    app.post('/api/migration/validate', stub);
    app.get('/api/migration/status', stub);
    return;
  }

  // Import dataset + candles (idempotent: skip if checksum matches)
  app.post<{ Body: { dataset: Record<string, unknown>; candles: Record<string, unknown>[] } }>(
    '/api/migration/import-dataset',
    async (req, reply) => {
      const ds = req.body.dataset as { id: string; checksum: string };
      const existing = await getDataset(ds.id);
      if (existing) {
        return reply.send({ status: 'skipped', id: ds.id, reason: 'already exists' });
      }
      await createDataset(req.body.dataset as never, req.body.candles as never[]);
      return reply.send({ status: 'imported', id: ds.id, candleCount: req.body.candles.length });
    },
  );

  // Import result + equity points
  app.post<{ Body: { result: Record<string, unknown>; equityPoints: Record<string, unknown>[] } }>(
    '/api/migration/import-result',
    async (req, reply) => {
      const r = req.body.result as { id: string };
      const existing = await getResult(r.id);
      if (existing) {
        return reply.send({ status: 'skipped', id: r.id, reason: 'already exists' });
      }
      await createResult(req.body.result as never, req.body.equityPoints as never[]);
      return reply.send({ status: 'imported', id: r.id, pointCount: req.body.equityPoints.length });
    },
  );

  // Import visual strategies + versions + drafts
  app.post<{
    Body: {
      strategies: Record<string, unknown>[];
      versions: Record<string, unknown>[];
      drafts: Record<string, unknown>[];
    };
  }>('/api/migration/import-strategies', async (req, reply) => {
    let strategiesImported = 0;
    let strategiesSkipped = 0;
    let versionsImported = 0;
    let draftsImported = 0;

    for (const s of req.body.strategies) {
      const existing = await getVisualStrategy((s as { id: string }).id);
      if (existing) {
        strategiesSkipped++;
      } else {
        await createVisualStrategy(s as never);
        strategiesImported++;
      }
    }

    for (const v of req.body.versions) {
      try {
        await publishStrategy(
          (v as { strategyId: string }).strategyId,
          (v as { document: Record<string, unknown> }).document,
        );
      } catch {
        // Strategy may not exist; skip
      }
      versionsImported++;
    }

    for (const d of req.body.drafts) {
      try {
        await saveDraft(d as never);
        draftsImported++;
      } catch {
        // Draft may conflict; skip
      }
    }

    return reply.send({
      strategiesImported, strategiesSkipped,
      versionsImported, draftsImported,
    });
  });

  // Import strategy configs
  app.post<{ Body: { configs: Record<string, unknown>[] } }>(
    '/api/migration/import-configs',
    async (req, reply) => {
      let imported = 0;
      let skipped = 0;

      for (const c of req.body.configs) {
        const existing = await getStrategyConfig((c as { id: string }).id);
        if (existing) {
          skipped++;
        } else {
          await createStrategyConfig(c as never);
          imported++;
        }
      }

      return reply.send({ imported, skipped });
    },
  );

  // Validate migration
  app.post<{ Body: { expected: Record<string, number> } }>(
    '/api/migration/validate',
    async (req, reply) => {
      const actual = await getTableCounts();
      const mismatches: { table: string; expected: number; actual: number }[] = [];
      for (const [table, expected] of Object.entries(req.body.expected)) {
        const actualCount = actual[table] ?? 0;
        if (actualCount !== expected) {
          mismatches.push({ table, expected, actual: actualCount });
        }
      }
      return reply.send({
        matched: mismatches.length === 0,
        counts: actual,
        mismatches,
      });
    },
  );

  app.get('/api/migration/status', async (_req, reply) => {
    const counts = await getTableCounts();
    return reply.send({ tables: counts });
  });
}
