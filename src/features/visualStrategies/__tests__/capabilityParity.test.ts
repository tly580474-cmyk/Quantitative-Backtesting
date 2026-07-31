import { describe, expect, it } from 'vitest';
import { INDICATOR_REGISTRY } from '@/features/indicators/registry';
import {
  GENERATED_VISUAL_INDICATOR_CAPABILITIES,
} from '../../../../server/src/services/strategyGeneration/generatedIndicatorCapabilities';

describe('generated strategy capability registry', () => {
  it('exactly matches the frontend indicator registry used by the UI', () => {
    const actual = INDICATOR_REGISTRY.map((indicator) => ({
      id: indicator.id,
      name: indicator.name,
      params: indicator.params,
      outputs: [...new Map(indicator.display.series.map((output) => [
        output.key,
        { key: output.key, label: output.label },
      ])).values()],
    }));

    expect(GENERATED_VISUAL_INDICATOR_CAPABILITIES).toEqual(actual);
  });
});
