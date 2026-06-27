import { describe, expect, it } from 'vitest';
import { validateDocument } from '@/features/visualStrategies/validator';
import { localGenerate, localRefine } from '../localMock';

describe('AI strategy local mock', () => {
  it('generates valid volume, breakout, and drawdown indicator nodes', async () => {
    const result = await localGenerate('放量突破前期高点，并在回撤 8% 时逐步加仓');
    const ids = result.strategy.indicators.map((indicator) => indicator.indicatorId);

    expect(ids).toEqual(expect.arrayContaining(['volume', 'highLowBreakout', 'drawdown']));
    expect(validateDocument(result.strategy)).toMatchObject({ valid: true, errors: [] });
  });

  it('creates a valid refinement draft without mutating the current strategy', async () => {
    const current = (await localGenerate('5 日均线上穿 20 日均线')).strategy;
    const originalUpdatedAt = current.metadata.updatedAt;
    const result = await localRefine(current, '将止损改为 6%');

    expect(result.strategy).not.toBe(current);
    expect(result.strategy.id).toBe(current.id);
    expect(result.strategy.metadata.source).toBe('ai');
    expect(result.strategy.metadata.aiGenerationId).toBe(result.generationId);
    expect(current.metadata.updatedAt).toBe(originalUpdatedAt);
    expect(validateDocument(result.strategy)).toMatchObject({ valid: true, errors: [] });
  });

  it('generates a trailing stop risk rule for post-entry peak drawdown requests', async () => {
    const result = await localGenerate('买入后最高价回撤 10% 时移动止盈');

    expect(result.strategy.risk).toContainEqual({ type: 'trailingStop', value: 10 });
    expect(result.strategy.indicators.some((indicator) => indicator.indicatorId === 'drawdown')).toBe(false);
    expect(validateDocument(result.strategy)).toMatchObject({ valid: true, errors: [] });
  });
});
