import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

export async function validateMultiAssetGovernanceBinding(input: {
  factorVersionId?: string;
  strategyVersionId?: string;
  snapshotId: string;
}): Promise<void> {
  let factorVersion: typeof schema.factorVersions.$inferSelect | undefined;
  if (input.factorVersionId) {
    const [row] = await getDb().select().from(schema.factorVersions)
      .where(eq(schema.factorVersions.id, input.factorVersionId)).limit(1);
    if (!row) throw new Error('MULTI_ASSET_FACTOR_VERSION_NOT_PUBLISHED');
    if (row.factorId !== 'momentum_20') throw new Error('MULTI_ASSET_FACTOR_NOT_SUPPORTED_BY_ENGINE');
    const expression = row.expression as { type?: string; id?: string };
    if (expression.type !== 'builtin' || expression.id !== 'momentum_20'
      || row.direction !== 'higher-is-better') {
      throw new Error('MULTI_ASSET_FACTOR_DEFINITION_PARITY_FAILED');
    }
    factorVersion = row;
  }
  if (input.strategyVersionId) {
    const [strategy] = await getDb().select().from(schema.factorStrategyVersions)
      .where(and(
        eq(schema.factorStrategyVersions.id, input.strategyVersionId),
      )).limit(1);
    if (!strategy) throw new Error('MULTI_ASSET_STRATEGY_VERSION_NOT_FOUND');
    if (!['validated', 'paper', 'champion'].includes(strategy.status)) {
      throw new Error('MULTI_ASSET_STRATEGY_NOT_GOVERNANCE_ELIGIBLE');
    }
    if (strategy.snapshotId !== input.snapshotId) throw new Error('MULTI_ASSET_STRATEGY_SNAPSHOT_MISMATCH');
    if (factorVersion) {
      const factors = strategy.factorVersions as Array<{ versionId?: string }>;
      if (!factors.some((item) => item.versionId === factorVersion!.id)) {
        throw new Error('MULTI_ASSET_FACTOR_NOT_BOUND_TO_STRATEGY');
      }
    }
  }
}
