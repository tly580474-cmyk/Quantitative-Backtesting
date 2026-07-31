import { describe, expect, it } from 'vitest';
import { buildStrategyConfirmationDraft } from './confirmationDraft.js';

describe('buildStrategyConfirmationDraft', () => {
  it('keeps extracted facts separate from explicit non-executable assumptions', () => {
    const strategy = {
      name: '双均线',
      indicators: [{ indicatorId: 'sma' }],
      entry: {
        type: 'group',
        children: [{
          type: 'condition',
          operator: 'crossesAbove',
        }],
      },
      exit: {
        type: 'group',
        children: [{
          type: 'condition',
          operator: 'crossesBelow',
        }],
      },
      risk: [{ type: 'stopLoss', value: 5 }],
    };

    const draft = buildStrategyConfirmationDraft('5 日线上穿 20 日线买入', strategy);

    expect(draft.sourceText).toBe('5 日线上穿 20 日线买入');
    expect(draft.extractedFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'entry', value: '1 条条件（crossesAbove）' }),
      expect.objectContaining({ key: 'risk', value: 'stopLoss(5)' }),
    ]));
    expect(draft.assumptions.map((item) => item.id)).toEqual([
      'universe',
      'frequency',
      'execution',
      'costs',
      'dateRange',
    ]);
    expect(draft.assumptions.every((item) => item.required)).toBe(true);
    expect(strategy).not.toHaveProperty('frequency');
    expect(strategy).not.toHaveProperty('execution');
  });
});
