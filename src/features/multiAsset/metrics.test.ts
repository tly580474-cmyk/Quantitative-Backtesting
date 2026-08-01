import { describe, expect, it } from 'vitest';
import { deriveMultiAssetRunMetrics, multiAssetStageLabel } from './metrics';
import type { StoredMultiAssetRun } from './types';

describe('multi-asset UI metrics', () => {
  it('derives ending equity, return and run counts from the authoritative result', () => {
    const run = {
      initialCash: 1_000_000,
      executionResult: {
        orders: [{}, {}],
        ledger: [{ equity: 1_050_000, cumulativeCosts: 600, positions: [{}, {}] }],
      },
      rebalancePlan: { decisions: [{}, {}, {}] },
    } as unknown as StoredMultiAssetRun;
    const metrics = deriveMultiAssetRunMetrics(run);
    expect(metrics).toMatchObject({
      endingEquity: 1_050_000,
      cumulativeCosts: 600,
      orderCount: 2,
      rebalanceCount: 3,
      positionCount: 2,
    });
    expect(metrics.totalReturn).toBeCloseTo(0.05, 10);
  });

  it('keeps incomplete results empty and maps worker stages for people', () => {
    expect(deriveMultiAssetRunMetrics(null).endingEquity).toBeNull();
    expect(multiAssetStageLabel('building_rebalance_plan')).toBe('生成并校验调仓计划');
    expect(multiAssetStageLabel('custom')).toBe('custom');
  });
});
