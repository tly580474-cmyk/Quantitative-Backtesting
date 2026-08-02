import { describe, expect, it } from 'vitest';
import {
  EVENT_STRATEGY_REGISTRY,
  getEventStrategyDefinition,
  listEventStrategyCatalog,
  parseEventStrategy,
} from './eventEngineStrategies.js';

describe('event engine strategy whitelist (N1.3)', () => {
  it('exposes a dual_ma definition with golden parity locked', () => {
    const definition = getEventStrategyDefinition('dual_ma');
    expect(definition).toBeDefined();
    expect(definition!.goldenParityLocked).toBe(true);
    expect(definition!.warmupBars({ fast: 5, slow: 20 })).toBe(20);
  });

  it('rejects unknown strategy types', () => {
    expect(() => parseEventStrategy({ type: 'unknown', params: {} })).toThrow();
  });

  it('rejects invalid dual_ma parameters', () => {
    expect(() => parseEventStrategy({ type: 'dual_ma', params: { fast: 20, slow: 5 } })).toThrow();
    expect(() => parseEventStrategy({ type: 'dual_ma', params: { fast: 1, slow: 20 } })).toThrow();
    expect(() => parseEventStrategy({ type: 'dual_ma', params: { fast: 5 } })).toThrow();
  });

  it('accepts valid dual_ma parameters', () => {
    const strategy = parseEventStrategy({ type: 'dual_ma', params: { fast: 5, slow: 20 } });
    expect(strategy.type).toBe('dual_ma');
  });

  it('lists the catalog deterministically', () => {
    const catalog = listEventStrategyCatalog();
    expect(catalog).toHaveLength(EVENT_STRATEGY_REGISTRY.size);
    expect(catalog.map((item) => item.id)).toContain('dual_ma');
  });
});
