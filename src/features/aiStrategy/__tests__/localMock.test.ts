import { describe, expect, it } from 'vitest';
import { validateDocument } from '@/features/visualStrategies/validator';
import { localGenerate } from '../localMock';

describe('AI strategy local mock', () => {
  it('generates valid volume, breakout, and drawdown indicator nodes', async () => {
    const result = await localGenerate('放量突破前期高点，并在回撤 8% 时逐步加仓');
    const ids = result.strategy.indicators.map((indicator) => indicator.indicatorId);

    expect(ids).toEqual(expect.arrayContaining(['volume', 'highLowBreakout', 'drawdown']));
    expect(validateDocument(result.strategy)).toMatchObject({ valid: true, errors: [] });
  });
});
