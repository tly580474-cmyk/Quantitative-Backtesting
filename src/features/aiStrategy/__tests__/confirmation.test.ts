import { describe, expect, it } from 'vitest';
import type { VisualStrategyDocument } from '@/features/visualStrategies/types';
import { buildLocalConfirmationDraft } from '../confirmation';

function strategy(): VisualStrategyDocument {
  const now = '2026-07-31T00:00:00.000Z';
  return {
    schemaVersion: '1.0',
    id: 's1',
    name: '双均线',
    description: '',
    strategyVersion: 1,
    parameters: [],
    indicators: [{
      id: 'ma',
      indicatorId: 'sma',
      params: { period1: 5, period2: 20 },
      outputs: [{ key: 'sma1', label: 'SMA5', type: 'number' }],
    }],
    entry: {
      type: 'group',
      id: 'entry',
      operator: 'all',
      children: [{
        type: 'condition',
        id: 'entry-1',
        left: { type: 'indicator', nodeId: 'ma', output: 'sma1', offset: 0 },
        operator: 'crossesAbove',
        right: { type: 'literal', value: 10 },
      }],
    },
    exit: {
      type: 'group',
      id: 'exit',
      operator: 'all',
      children: [{
        type: 'condition',
        id: 'exit-1',
        left: { type: 'indicator', nodeId: 'ma', output: 'sma1', offset: 0 },
        operator: 'crossesBelow',
        right: { type: 'literal', value: 10 },
      }],
    },
    risk: [],
    metadata: { source: 'ai', createdAt: now, updatedAt: now },
  };
}

describe('buildLocalConfirmationDraft', () => {
  it('separates source, extracted facts and assumptions', () => {
    const draft = buildLocalConfirmationDraft('均线交叉策略', strategy());

    expect(draft.sourceText).toBe('均线交叉策略');
    expect(draft.extractedFields.find((item) => item.key === 'entry')?.value)
      .toBe('1 条条件（crossesAbove）');
    expect(draft.assumptions).toHaveLength(5);
    expect(draft.assumptions.every((item) => item.required)).toBe(true);
  });
});
