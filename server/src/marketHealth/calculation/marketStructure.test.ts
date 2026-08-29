import { describe, expect, it } from 'vitest';
import { calculateMarketStructure, type MarketStructureRawPoint } from './marketStructure.js';

function points(count = 260): MarketStructureRawPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    tradeDate: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    eligibleStocks: 5000 + index,
    availableIndices: 5,
    availableIndustries: 31,
    indexReturn20d: -0.1 + index * 0.001,
    indexReturn60d: -0.2 + index * 0.002,
    indexTrendAlignment: 0.4 + index * 0.001,
    pctAboveMa20: 35 + index * 0.1,
    pctAboveMa60: 30 + index * 0.1,
    pctIndustriesAboveMa60: 30 + index * 0.1,
    downsideSemivol20d: 0.3 - index * 0.0005,
    drawdownMagnitude60d: 0.2 - index * 0.0003,
    downsideComovement20d: 0.7 - index * 0.0005,
    medianAmihud20d: 0.02 - index * 0.00002,
    liquidityDroughtFraction: 0.4 - index * 0.0005,
    turnoverTop5PctShare: 0.5 - index * 0.0005,
  }));
}

describe('market structure health', () => {
  it('uses the frozen four component weights', () => {
    const result = calculateMarketStructure(points(), 'snapshot-1');
    expect(result?.components.map((item) => item.weight)).toEqual([0.3, 0.25, 0.3, 0.15]);
    expect(result?.direction).toBe('higher_is_better');
    expect(result?.publicationStatus).toBe('published');
  });

  it('rejects insufficient history or missing core index coverage', () => {
    expect(calculateMarketStructure(points(252), 'snapshot-1')).toBeNull();
    const missing = points();
    missing.at(-1)!.availableIndices = 3;
    expect(calculateMarketStructure(missing, 'snapshot-1')).toBeNull();
  });
});
