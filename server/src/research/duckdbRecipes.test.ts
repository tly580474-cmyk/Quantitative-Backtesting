import { describe, expect, it } from 'vitest';
import { buildRecipe, listRecipes } from './duckdbRecipes.js';

const emptyOptions = {
  factors: [],
  weights: [],
  markets: [],
  symbols: [],
  where: [],
};

describe('duckdb quantitative recipes', () => {
  it('lists the available research recipes', () => {
    expect(listRecipes().map((item) => item.name)).toEqual([
      'factor-screen',
      'factor-layer',
      'timeseries',
    ]);
  });

  it('builds weighted multi-factor screening SQL', () => {
    const result = buildRecipe('factor-screen', {
      ...emptyOptions,
      factors: ['momentum_20', 'volume_ratio_20'],
      weights: ['momentum_20=2'],
      startDate: '2026-01-01',
      top: '20',
    });
    expect(result.sql).toContain('PERCENT_RANK()');
    expect(result.sql).toContain('2.0 * COALESCE(z_momentum_20');
    expect(result.sql).toContain('AVG(volume) OVER trailing_20');
    expect(result.params.limit).toBe(20);
  });

  it('builds factor layer future-return statistics', () => {
    const result = buildRecipe('factor-layer', {
      ...emptyOptions,
      factors: ['momentum_20'],
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      horizon: '5',
      layers: '5',
    });
    expect(result.sql).toContain('LEAD(open, 1)');
    expect(result.sql).toContain('LEAD(close, 5)');
    expect(result.sql).toContain('NTILE($layers)');
    expect(result.params.layers).toBe(5);
    expect(result.params).not.toHaveProperty('horizon');
  });

  it('builds allowlisted time aggregation SQL', () => {
    const result = buildRecipe('timeseries', {
      ...emptyOptions,
      symbols: ['002155'],
      period: 'month',
      rollingWindow: '6',
    });
    expect(result.sql).toContain("DATE_TRUNC('month'");
    expect(result.sql).toContain('ROWS BETWEEN 5 PRECEDING');
    expect(result.params.symbol0).toBe('002155');
  });

  it('rejects unsafe appended conditions', () => {
    expect(() => buildRecipe('factor-screen', {
      ...emptyOptions,
      where: ['amount > 0; DROP TABLE bars'],
    })).toThrow('不能包含分号');
  });
});
