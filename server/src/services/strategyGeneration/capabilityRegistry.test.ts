import { describe, expect, it } from 'vitest';
import { buildStrategyCapabilityRegistry } from './capabilityRegistry.js';
import { GENERATED_VISUAL_INDICATOR_CAPABILITIES } from './generatedIndicatorCapabilities.js';

describe('buildStrategyCapabilityRegistry', () => {
  it('derives visual indicators and a stable content version from generated capabilities', () => {
    const first = buildStrategyCapabilityRegistry(['factor-b', 'factor-a', 'factor-a']);
    const second = buildStrategyCapabilityRegistry(['factor-a', 'factor-b']);

    expect(first.visualIndicators).toEqual(GENERATED_VISUAL_INDICATOR_CAPABILITIES);
    expect(first.publishedFactorVersionIds).toEqual(['factor-a', 'factor-b']);
    expect(first.capabilityVersion).toBe(second.capabilityVersion);
    expect(first.capabilityVersion).toMatch(/^[a-f0-9]{64}$/);
  });
});
