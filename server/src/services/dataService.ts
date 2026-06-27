import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

const {
  marketDatasets,
  candles,
  strategyConfigs,
  backtestResults,
  equityPoints,
  visualStrategies,
  strategyVersions,
  strategyDrafts,
} = schema;

const CHUNK_SIZE = 500;

// ─── Datasets ────────────────────────────────────────────────────

export async function listDatasets() {
  return getDb()
    .select()
    .from(marketDatasets)
    .orderBy(desc(marketDatasets.createdAt));
}

export async function getDataset(id: string) {
  const rows = await getDb()
    .select()
    .from(marketDatasets)
    .where(eq(marketDatasets.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createDataset(
  dataset: typeof marketDatasets.$inferInsert,
  candleRows: Omit<typeof candles.$inferInsert, 'datasetId'>[],
) {
  const linkedCandleRows = candleRows.map((row) => ({
    ...row,
    datasetId: dataset.id,
  }));

  await getDb().transaction(async (tx) => {
    await tx
      .insert(marketDatasets)
      .values(dataset)
      .onDuplicateKeyUpdate({ set: dataset });

    await tx.delete(candles).where(eq(candles.datasetId, dataset.id));
    for (let i = 0; i < linkedCandleRows.length; i += CHUNK_SIZE) {
      await tx.insert(candles).values(linkedCandleRows.slice(i, i + CHUNK_SIZE));
    }
  });
}

export async function deleteDataset(id: string) {
  await getDb().transaction(async (tx) => {
    await tx.delete(candles).where(eq(candles.datasetId, id));
    await tx.delete(marketDatasets).where(eq(marketDatasets.id, id));
  });
}

export async function getCandles(
  datasetId: string,
  offset: number,
  limit: number,
) {
  const data = await getDb()
    .select()
    .from(candles)
    .where(eq(candles.datasetId, datasetId))
    .orderBy(candles.time)
    .limit(limit)
    .offset(offset);

  const [row] = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(candles)
    .where(eq(candles.datasetId, datasetId));

  return { data, total: Number(row?.count ?? 0), offset, limit };
}

export async function findDuplicateByChecksum(checksum: string) {
  const rows = await getDb()
    .select()
    .from(marketDatasets)
    .where(eq(marketDatasets.checksum, checksum))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Strategy Configs ────────────────────────────────────────────

export async function listStrategyConfigs() {
  return getDb()
    .select()
    .from(strategyConfigs)
    .orderBy(desc(strategyConfigs.createdAt));
}

export async function getStrategyConfig(id: string) {
  const rows = await getDb()
    .select()
    .from(strategyConfigs)
    .where(eq(strategyConfigs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createStrategyConfig(
  config: typeof strategyConfigs.$inferInsert,
) {
  await getDb().insert(strategyConfigs).values(config);
}

export async function deleteStrategyConfig(id: string) {
  await getDb().delete(strategyConfigs).where(eq(strategyConfigs.id, id));
}

// ─── Backtest Results ────────────────────────────────────────────

export async function listResults() {
  // Avoid sorting rows containing large JSON payloads in MySQL's sort buffer.
  // First sort only the indexed IDs, then fetch full rows in bounded chunks.
  const orderedIds = await getDb()
    .select({ id: backtestResults.id })
    .from(backtestResults)
    .orderBy(desc(backtestResults.startedAt));

  if (orderedIds.length === 0) return [];

  const rows: (typeof backtestResults.$inferSelect)[] = [];
  for (let i = 0; i < orderedIds.length; i += CHUNK_SIZE) {
    const ids = orderedIds.slice(i, i + CHUNK_SIZE).map(({ id }) => id);
    rows.push(...await getDb()
      .select()
      .from(backtestResults)
      .where(inArray(backtestResults.id, ids)));
  }

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return orderedIds.flatMap(({ id }) => {
    const row = rowsById.get(id);
    return row ? [row] : [];
  });
}

export async function getResult(id: string) {
  const rows = await getDb()
    .select()
    .from(backtestResults)
    .where(eq(backtestResults.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createResult(
  result: typeof backtestResults.$inferInsert,
  equityRows: (typeof equityPoints.$inferInsert)[],
) {
  // Equity points originate from BacktestResult.equityCurve, whose domain model
  // deliberately has no persistence-only resultId field.  Attach the foreign
  // key at the service boundary so both regular saves and migration imports are
  // written atomically instead of failing the entire transaction on result_id.
  const linkedEquityRows = equityRows.map((point) => ({
    ...point,
    resultId: result.id,
  }));

  await getDb().transaction(async (tx) => {
    await tx.insert(backtestResults).values(result);
    for (let i = 0; i < linkedEquityRows.length; i += CHUNK_SIZE) {
      await tx.insert(equityPoints).values(linkedEquityRows.slice(i, i + CHUNK_SIZE));
    }
  });
}

export async function deleteResult(id: string) {
  await getDb().delete(backtestResults).where(eq(backtestResults.id, id));
}

export async function bulkDeleteResults(ids: string[]) {
  if (ids.length === 0) return;
  await getDb()
    .delete(backtestResults)
    .where(inArray(backtestResults.id, ids));
}

export async function getEquityPoints(
  resultId: string,
  offset: number,
  limit: number,
) {
  const data = await getDb()
    .select()
    .from(equityPoints)
    .where(eq(equityPoints.resultId, resultId))
    .orderBy(equityPoints.time)
    .limit(limit)
    .offset(offset);

  const [row] = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(equityPoints)
    .where(eq(equityPoints.resultId, resultId));

  return { data, total: Number(row?.count ?? 0), offset, limit };
}

// ─── Visual Strategies ───────────────────────────────────────────

export async function listVisualStrategies() {
  return getDb()
    .select()
    .from(visualStrategies)
    .orderBy(desc(visualStrategies.updatedAt));
}

export async function getVisualStrategy(id: string) {
  const rows = await getDb()
    .select()
    .from(visualStrategies)
    .where(eq(visualStrategies.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createVisualStrategy(
  strategy: typeof visualStrategies.$inferInsert,
) {
  await getDb()
    .insert(visualStrategies)
    .values(strategy)
    .onDuplicateKeyUpdate({
      set: {
        name: strategy.name,
        document: strategy.document,
        status: strategy.status,
        updatedAt: strategy.updatedAt,
      },
    });
}

export async function deleteVisualStrategy(id: string) {
  await getDb().transaction(async (tx) => {
    await tx.delete(strategyDrafts).where(eq(strategyDrafts.strategyId, id));
    await tx.delete(strategyVersions).where(eq(strategyVersions.strategyId, id));
    await tx.delete(visualStrategies).where(eq(visualStrategies.id, id));
  });
}

export async function publishStrategy(
  id: string,
  document: Record<string, unknown>,
) {
  await getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, id))
      .orderBy(desc(strategyVersions.version))
      .limit(1);
    const nextVersion = (rows[0]?.version ?? 0) + 1;

    await tx.insert(strategyVersions).values({
      id: crypto.randomUUID(),
      strategyId: id,
      version: nextVersion,
      document,
      createdAt: new Date().toISOString(),
    });

    await tx
      .update(visualStrategies)
      .set({
        document,
        status: 'published',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(visualStrategies.id, id));
  });
}

export async function getVersions(strategyId: string) {
  return getDb()
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, strategyId))
    .orderBy(desc(strategyVersions.version));
}

export async function getVersion(strategyId: string, version: number) {
  const rows = await getDb()
    .select()
    .from(strategyVersions)
    .where(
      and(
        eq(strategyVersions.strategyId, strategyId),
        eq(strategyVersions.version, version),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function saveDraft(draft: typeof strategyDrafts.$inferInsert) {
  const existing = await getDraft(draft.strategyId);
  if (existing) {
    await getDb()
      .update(strategyDrafts)
      .set({ document: draft.document, updatedAt: draft.updatedAt })
      .where(eq(strategyDrafts.strategyId, draft.strategyId));
  } else {
    await getDb().insert(strategyDrafts).values(draft);
  }
}

export async function getDraft(strategyId: string) {
  const rows = await getDb()
    .select()
    .from(strategyDrafts)
    .where(eq(strategyDrafts.strategyId, strategyId))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteDraft(strategyId: string) {
  await getDb()
    .delete(strategyDrafts)
    .where(eq(strategyDrafts.strategyId, strategyId));
}

// ─── Migration Helpers ───────────────────────────────────────────

export async function getTableCounts() {
  const tables = [
    'market_datasets', 'candles', 'strategy_configs',
    'backtest_results', 'equity_points', 'visual_strategies',
    'strategy_versions', 'strategy_drafts',
  ] as const;

  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await getDb().execute(
      sql.raw(`SELECT COUNT(*) as cnt FROM ${table}`),
    );
    const rowObj = row as unknown as { cnt: number };
    counts[table] = Number(rowObj.cnt ?? 0);
  }
  return counts;
}
