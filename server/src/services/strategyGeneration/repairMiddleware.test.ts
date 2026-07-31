import { describe, expect, it } from 'vitest';
import { repairStrategyCandidate } from './repairMiddleware.js';

function candidate() {
  return {
    schemaVersion: '1.0',
    id: 'strategy-1',
    name: '测试策略',
    description: '',
    strategyVersion: '1',
    parameters: [{
      name: 'threshold',
      label: '阈值',
      type: 'number',
      defaultValue: '12.5',
      min: '1',
      max: '20',
      step: '0.5',
    }],
    indicators: [{
      id: 'sma-1',
      indicatorId: 'sma',
      params: { period1: '5' },
      outputs: [{ key: 'sma1', label: 'SMA5' }],
    }],
    entry: {
      type: 'group',
      id: 'entry',
      operator: 'all',
      children: [{
        type: 'condition',
        id: 'entry-1',
        left: { type: 'market', field: 'close', offset: '0' },
        operator: 'gt',
        right: { type: 'parameter', name: 'threshold' },
      }],
    },
    exit: {
      type: 'group',
      id: 'exit',
      operator: 'all',
      children: [{
        type: 'condition',
        id: 'exit-1',
        left: { type: 'market', field: 'close', offset: '0' },
        operator: 'lt',
        right: { type: 'literal', value: '8' },
      }],
    },
    risk: [{ type: 'stopLoss', value: '5' }],
    metadata: {
      source: 'visual',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('repairStrategyCandidate', () => {
  it('only performs representation and system-metadata repairs with an audit trail', () => {
    const input = candidate();
    const original = structuredClone(input);
    const result = repairStrategyCandidate(
      input,
      'generation-1',
      '2026-07-31T00:00:00.000Z',
    );
    const repaired = result.candidate as ReturnType<typeof candidate> & {
      indicators: Array<{
        params: { period1: number };
        outputs: Array<{ type?: string }>;
      }>;
    };

    expect(input).toEqual(original);
    expect(repaired.strategyVersion).toBe(1);
    expect(repaired.parameters[0].defaultValue).toBe(12.5);
    expect(repaired.indicators[0].params.period1).toBe(5);
    expect(repaired.indicators[0].outputs[0].type).toBe('number');
    expect(repaired.entry.children[0].left.offset).toBe(0);
    expect(repaired.exit.children[0].right.value).toBe(8);
    expect(repaired.risk[0].value).toBe(5);
    expect(repaired.metadata).toMatchObject({
      source: 'ai',
      aiGenerationId: 'generation-1',
      updatedAt: '2026-07-31T00:00:00.000Z',
    });
    expect(result.audit.changed).toBe(true);
    expect(result.audit.originalCandidate).toEqual(original);
    expect(result.audit.beforeHash).not.toBe(result.audit.afterHash);
    expect(new Set(result.audit.operations.map((operation) => operation.kind))).toEqual(
      new Set([
        'numeric-string-to-number',
        'literal-output-type',
        'system-metadata-enrichment',
      ]),
    );
  });

  it('does not infer missing rules, wrap arrays, remove parameters, or rename indicators', () => {
    const input = {
      id: 'incomplete',
      parameters: [{ name: 'unused', type: 'number', defaultValue: 1 }],
      indicators: [{ id: 'x', indicatorId: 'unknown', params: {}, outputs: [] }],
      entry: [],
      metadata: {},
    };
    const result = repairStrategyCandidate(input, 'generation-2', '2026-07-31T00:00:00.000Z');
    const repaired = result.candidate as typeof input;

    expect(repaired.entry).toEqual([]);
    expect(repaired.parameters).toEqual(input.parameters);
    expect(repaired.indicators[0].indicatorId).toBe('unknown');
    expect(repaired).not.toHaveProperty('exit');
    expect(repaired).not.toHaveProperty('schemaVersion');
  });
});
